import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { parseModelId, createRetryConfig, executeWithRetry, normalizeUserModels } from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { countMessageTokens } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi } from "./commonApi";
import { createResponsesReasoningPart } from "./openai/responsesState";
import { createModelFetch } from "./httpClient";
import { logger } from "./logger";
import {
	PROXY_PROBE_DEFAULT_TIMEOUT_MS,
	normalizeProxyProfiles,
	resolveProxyForModel,
	selectProxyEntry,
} from "./proxyConfig";
import { isUpstreamProviderFailureError, registerSessionId, resolveSessionId, rotateSessionId } from "./sessionRouting";

/** Label used in logs when no proxy is applied. */
const DIRECT_PROXY_LABEL = "direct";

/**
 * VS Code Chat provider backed by custom OpenAI-compatible endpoints.
 */
export class CustomOaiChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
	/**
	 * Fired when `oaicopilot.models` (or related endpoint settings) change so the
	 * workbench — including the Agents window / Copilot harness, which consumes
	 * this vendor through the built-in BYOK bridge — re-enumerates the models
	 * without a reload.
	 */
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> =
		this._onDidChangeLanguageModelChatInformation.event;

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();

	/**
	 * Notify the workbench that this vendor's model list changed.
	 * Consumers debounce `onDidChangeLanguageModels`, so a single fire per config
	 * save is enough for added/removed/renamed models to show up without a reload.
	 */
	public notifyModelsChanged(): void {
		try {
			this._onDidChangeLanguageModelChatInformation.fire();
		} catch (e) {
			console.error("[Custom OAI Provider] notifyModelsChanged failed", e);
		}
	}

	/** Release the model-change emitter. */
	public dispose(): void {
		try {
			this._onDidChangeLanguageModelChatInformation.dispose();
		} catch {
			/* ignore */
		}
	}

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly statusBarItem: vscode.StatusBarItem
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token, this.secrets);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return countMessageTokens(text, { includeReasoningInRequest: true });
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					if (part instanceof vscode.LanguageModelTextPart) {
						collectedOutputText.push(part.value);
					}
					progress.report(part);
				} catch (e) {
					console.error("[Custom OAI Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		const requestStartTime = Date.now();
		const collectedOutputText: string[] = [];
		try {
			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

			// Parse model ID to handle config ID
			const parsedModelId = parseModelId(model.id);

			// Find matching user model configuration
			// Prioritize matching models with same base ID and config ID
			// If no config ID, match models with same base ID
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// If still no model found, try to find any model matching the base ID (most lenient match, for backward compatibility)
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
			}

			// Check if using Ollama native API mode
			const apiMode = um?.apiMode ?? "openai";
			const baseUrl = um?.baseUrl || config.get<string>("oaicopilot.baseUrl", "");

			logger.info("request.start", {
				modelId: model.id,
				messageCount: messages.length,
				apiMode,
				baseUrl,
			});

			// Prepare model configuration
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? um?.opencodeSession === true,
			};

			// Update Token Usage
			updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig);

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("oaicopilot.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					logger.debug("request.delay", {
						delayMs,
						elapsed,
						remainingDelay,
					});
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key for the model's provider
			const provider = um?.owned_by;
			const useGenericKey = !um?.baseUrl;
			const modelApiKey = await this.ensureApiKey(useGenericKey, provider);
			if (!modelApiKey) {
				logger.warn("apiKey.missing", {
					provider: provider ?? "",
					useGenericKey,
				});
				throw new Error("Custom OAI API key not found");
			}

			// send chat request
			const BASE_URL = baseUrl;
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			// get retry config
			const retryConfig = createRetryConfig();
			const opencodeSessionEnabled = um?.opencodeSession === true;
			const session = opencodeSessionEnabled ? resolveSessionId(model.id, messages) : undefined;
			// The Responses API needs a stable per-conversation `prompt_cache_key`
			// even without the opencode session contract (a model-wide key lets
			// different conversations share/poison each other's cache). Resolve one
			// through the same anchor mechanism, but never send it as a header.
			const responsesCacheSession =
				!opencodeSessionEnabled && apiMode === "openai-responses" ? resolveSessionId(model.id, messages) : undefined;
			const opencodeExtraHeaders: Record<string, string> | undefined = opencodeSessionEnabled
				? {
						"x-opencode-request": `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
						"x-opencode-client": "custom-oai-copilot",
					}
				: undefined;

			// prepare headers with custom headers if specified
			const requestHeaders = CommonApi.prepareHeaders(
				modelApiKey,
				apiMode,
				um?.headers,
				session?.sessionId,
				opencodeExtraHeaders
			);
			logger.debug("request.headers", {
				headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
			});
			if (session) {
				logger.info("request.session", {
					modelId: model.id,
					sessionRegistered: session.registered,
				});
			}
			logger.debug("request.messages.origin", {
				messages: messages,
			});

			const requestTimeoutMs = um?.timeoutMs && um.timeoutMs > 0 ? um.timeoutMs : 0;

			// Resolve the effective proxy for this request (per-model spec wins over the
			// global spec; both support URLs, profile names and failover lists).
			const proxyProfiles = normalizeProxyProfiles(config.get<unknown>("oaicopilot.proxies", []));
			const proxyResolution = resolveProxyForModel(
				um?.proxy,
				config.get<string>("oaicopilot.proxy", ""),
				proxyProfiles.profiles,
				vscode.env.remoteName
			);
			for (const warning of [...proxyProfiles.warnings, ...proxyResolution.warnings]) {
				logger.warn("proxy.warning", { modelId: model.id, warning });
			}
			const proxyProbeTimeoutMs = config.get<number>("oaicopilot.proxyProbeTimeoutMs", PROXY_PROBE_DEFAULT_TIMEOUT_MS);
			const chosenProxy = await selectProxyEntry(proxyResolution.entries, proxyProbeTimeoutMs);
			if (chosenProxy.probeFailures.length > 0) {
				logger.warn("proxy.probeFailures", { modelId: model.id, failures: chosenProxy.probeFailures });
			}
			const chosenProxyLabel = chosenProxy.entry?.label ?? DIRECT_PROXY_LABEL;
			const activeProxyRaw = chosenProxy.entry?.kind === "proxy" ? chosenProxy.entry.raw : "";
			if (proxyResolution.entries.length > 0) {
				logger.info("request.proxy", {
					modelId: model.id,
					candidates: proxyResolution.entries.map((e) => e.label),
					chosen: chosenProxyLabel,
				});
			}

			const useLongLivedFetch = Boolean(activeProxyRaw) || requestTimeoutMs > 0;
			const controller = new AbortController();
			const timeoutId =
				requestTimeoutMs > 0
					? setTimeout(() => {
							if (!controller.signal.aborted) {
								controller.abort();
							}
						}, requestTimeoutMs)
					: undefined;
			const cancelListener = token.onCancellationRequested(() => {
				if (!controller.signal.aborted) {
					controller.abort();
				}
			});
			const dispatchFetch = useLongLivedFetch
				? createModelFetch({ proxy: activeProxyRaw || undefined, timeoutMs: requestTimeoutMs || undefined })
				: fetch;
			const fetchInit = (headers: Record<string, string>, body: unknown): RequestInit => ({
				method: "POST",
				headers,
				body: JSON.stringify(body),
				...(useLongLivedFetch ? { signal: controller.signal } : {}),
			});
			const rotateSession = (): void => {
				if (!opencodeSessionEnabled) {
					return;
				}
				const previousSessionId = requestHeaders["x-opencode-session"];
				requestHeaders["x-opencode-session"] = rotateSessionId(model.id, messages);
				logger.warn("request.sessionRotated", {
					modelId: model.id,
					previousSessionId,
					newSessionId: requestHeaders["x-opencode-session"],
				});
			};
			const sendWithSessionFallback = async (send: () => Promise<Response>): Promise<Response> => {
				try {
					return await send();
				} catch (err) {
					if (!opencodeSessionEnabled || !isUpstreamProviderFailureError(err)) {
						throw err;
					}
					rotateSession();
					return await send();
				}
			};
			const throwHttpError = (kind: string, res: Response, errorText: string, url: string): never => {
				const error = new Error(
					`${kind}: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
				);
				(error as { status?: number; errorText?: string }).status = res.status;
				(error as { status?: number; errorText?: string }).errorText = errorText;
				throw error;
			};
			const registerOpenCodeSessionIfNeeded = (): void => {
				if (opencodeSessionEnabled && session && !session.registered) {
					registerSessionId(model.id, messages, collectedOutputText.join(""), requestHeaders["x-opencode-session"]);
				}
				if (!opencodeSessionEnabled && responsesCacheSession && !responsesCacheSession.registered) {
					registerSessionId(model.id, messages, collectedOutputText.join(""), responsesCacheSession.sessionId);
				}
			};

			try {
				if (apiMode === "ollama") {
					// Ollama native API mode
					const ollamaApi = new OllamaApi(model.id);
					const ollamaMessages = ollamaApi.convertMessages(messages, modelConfig);

					let ollamaRequestBody: OllamaRequestBody = {
						model: parsedModelId.baseId,
						messages: ollamaMessages,
						stream: true,
					};
					ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, um, options);

					// send Ollama chat request with retry
					const url = `${BASE_URL.replace(/\/+$/, "")}/api/chat`;
					logger.debug("request.body", {
						url: url,
						requestBody: ollamaRequestBody,
					});
					const response = await sendWithSessionFallback(async () =>
						executeWithRetry(async () => {
							const res = await dispatchFetch(url, fetchInit({ ...requestHeaders }, ollamaRequestBody));

							if (!res.ok) {
								const errorText = await res.text();
								console.error("[Ollama Provider] Ollama API error response", errorText);
								throwHttpError("Ollama API error", res, errorText, url);
							}

							return res;
						}, retryConfig)
					);

					if (!response.body) {
						throw new Error("No response body from Ollama API");
					}
					await ollamaApi.processStreamingResponse(response.body, trackingProgress, token);
					registerOpenCodeSessionIfNeeded();
				} else if (apiMode === "anthropic") {
					// Anthropic API mode
					const anthropicApi = new AnthropicApi(model.id, um?.cache_control !== false);
					const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

					// requestBody
					let requestBody: AnthropicRequestBody = {
						model: parsedModelId.baseId,
						messages: anthropicMessages,
						stream: true,
					};
					requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

					// send Anthropic chat request with retry
					const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
					// Some providers require configuring the baseUrl with a version suffix (e.g. .../v1).
					// Avoid double-appending (e.g. .../v1/v1/messages).
					const url = normalizedBaseUrl.endsWith("/v1")
						? `${normalizedBaseUrl}/messages`
						: `${normalizedBaseUrl}/v1/messages`;
					logger.debug("request.body", { url, requestBody });
					const response = await sendWithSessionFallback(async () =>
						executeWithRetry(async () => {
							const res = await dispatchFetch(url, fetchInit({ ...requestHeaders }, requestBody));

							if (!res.ok) {
								const errorText = await res.text();
								console.error("[Anthropic Provider] Anthropic API error response", errorText);
								throwHttpError("Anthropic API error", res, errorText, url);
							}

							return res;
						}, retryConfig)
					);

					if (!response.body) {
						throw new Error("No response body from Anthropic API");
					}
					await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
					registerOpenCodeSessionIfNeeded();
				} else if (apiMode === "openai-responses") {
					// OpenAI Responses API mode. Stateless full-history sends, Codex-style:
					// no automatic `previous_response_id` chaining — relays in the wild
					// (e.g. suixiang) answer HTTP 200 with an in-stream error instead of
					// supporting server-side chaining, which previously caused 60-90s
					// empty turns. A manual escape hatch stays via
					// `extra: { previous_response_id }`, respected as-is.
					const openaiResponsesApi = new OpenaiResponsesApi(model.id);
					const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");

					// Convert full history once (also extracts system `instructions`).
					const fullInput = openaiResponsesApi.convertMessages(messages, modelConfig);

					// requestBody
					let requestBody: Record<string, unknown> = {
						model: parsedModelId.baseId,
						input: fullInput,
						stream: true,
					};

					requestBody = openaiResponsesApi.prepareRequestBody(requestBody, um, options);

					if (!requestBody.prompt_cache_key) {
						requestBody.prompt_cache_key = opencodeSessionEnabled
							? session!.sessionId
							: `oaicopilot-${parsedModelId.baseId}-${responsesCacheSession!.sessionId}`;
					}
					if (opencodeSessionEnabled) {
						if (requestBody.store === undefined) {
							requestBody.store = false;
						}
					}

					const manualPreviousResponseId =
						typeof requestBody.previous_response_id === "string" && requestBody.previous_response_id.length > 0;

					const url = `${normalizedBaseUrl}/responses`;
					logger.info("request.responsesState", {
						modelId: model.id,
						opencodeSession: opencodeSessionEnabled,
						manualPreviousResponseId,
						cacheSessionRegistered: opencodeSessionEnabled ? session?.registered : responsesCacheSession?.registered,
						proxy: chosenProxyLabel,
						timeoutMs: requestTimeoutMs,
					});
					logger.debug("request.body", { url, requestBody });

					const sendRequest = async (body: Record<string, unknown>) =>
						await executeWithRetry(async () => {
							const res = await dispatchFetch(url, fetchInit({ ...requestHeaders }, body));

							if (!res.ok) {
								const errorText = await res.text();
								console.error("[Responses Provider] Responses API error response", errorText);
								throwHttpError("Responses API error", res, errorText, url);
							}

							return res;
						}, retryConfig);

					// Strict relays may reject the `include: ["reasoning.encrypted_content"]`
					// parameter. On a client error, retry once without it — the fallback
					// wire shape is then plain Codex-style input.
					const buildFallbackBody = (): Record<string, unknown> => {
						let fallbackBody: Record<string, unknown> = {
							model: parsedModelId.baseId,
							input: fullInput,
							stream: true,
						};
						fallbackBody = openaiResponsesApi.prepareRequestBody(fallbackBody, um, options);
						if (!fallbackBody.prompt_cache_key) {
							fallbackBody.prompt_cache_key = opencodeSessionEnabled
								? session!.sessionId
								: `oaicopilot-${parsedModelId.baseId}-${responsesCacheSession!.sessionId}`;
						}
						delete fallbackBody.include;
						return fallbackBody;
					};
					const isClientErrorStatus = (status: unknown): boolean =>
						typeof status === "number" && status >= 400 && status < 500 && status !== 429;

					let response: Response;
					try {
						response = await sendWithSessionFallback(() => sendRequest(requestBody));
					} catch (err) {
						const status = (err as { status?: unknown })?.status;
						if (!isClientErrorStatus(status) || requestBody.include === undefined) {
							throw err;
						}
						const fallbackBody = buildFallbackBody();
						logger.warn("request.responsesFallback", {
							modelId: model.id,
							status,
							dropped: ["include"],
						});
						response = await sendRequest(fallbackBody);
					}

					if (!response.body) {
						throw new Error("No response body from Responses API");
					}
					openaiResponsesApi.lastStreamUrl = url;
					try {
						await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);
					} catch (streamErr) {
						// Relays that reject `include` answer HTTP 200 with an in-stream
						// error payload. Retry once against a fresh stream without it.
						const status = (streamErr as { status?: unknown })?.status;
						if (
							streamErr instanceof Error &&
							/Responses API error:/.test(streamErr.message) &&
							status === 502 &&
							requestBody.include !== undefined &&
							!token.isCancellationRequested
						) {
							const fallbackBody = buildFallbackBody();
							logger.warn("request.responsesFallback", {
								modelId: model.id,
								status,
								dropped: ["include"],
								afterStreamError: true,
							});
							response = await sendRequest(fallbackBody);
							if (!response.body) {
								throw new Error("No response body from Responses API");
							}
							openaiResponsesApi.lastStreamUrl = url;
							await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);
						} else {
							throw streamErr;
						}
					}

					for (const item of openaiResponsesApi.takeCapturedReasoningItems()) {
						trackingProgress.report(createResponsesReasoningPart(item));
					}
					registerOpenCodeSessionIfNeeded();
				} else if (apiMode === "gemini") {
					// Gemini native API mode
					const geminiApi = new GeminiApi(model.id, this._geminiToolCallMetaByCallId);
					const geminiMessages = geminiApi.convertMessages(messages, modelConfig);

					const systemParts: string[] = [];
					const contents: GeminiGenerateContentRequest["contents"] = [];
					for (const msg of geminiMessages) {
						if (msg.role === "system") {
							const text = msg.parts
								.map((p) =>
									p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
										? String((p as { text: string }).text)
										: ""
								)
								.join("")
								.trim();
							if (text) {
								systemParts.push(text);
							}
							continue;
						}
						contents.push({ role: msg.role, parts: msg.parts });
					}

					let requestBody: GeminiGenerateContentRequest = {
						contents,
					};
					if (systemParts.length > 0) {
						requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
					}
					requestBody = geminiApi.prepareRequestBody(requestBody, um, options);

					const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
					logger.debug("request.body", { url, requestBody });
					if (!url) {
						throw new Error("Invalid Gemini base URL configuration.");
					}

					const response = await sendWithSessionFallback(async () =>
						executeWithRetry(async () => {
							const res = await dispatchFetch(url, fetchInit({ ...requestHeaders }, requestBody));

							if (!res.ok) {
								const errorText = await res.text();
								console.error("[Gemini Provider] Gemini API error response", errorText);
								throwHttpError("Gemini API error", res, errorText, url);
							}

							return res;
						}, retryConfig)
					);

					if (!response.body) {
						throw new Error("No response body from Gemini API");
					}
					await geminiApi.processStreamingResponse(response.body, trackingProgress, token);
					registerOpenCodeSessionIfNeeded();
				} else {
					// OpenAI compatible API mode (default)
					const openaiApi = new OpenaiApi(model.id);
					const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

					// requestBody
					let requestBody: Record<string, unknown> = {
						model: parsedModelId.baseId,
						messages: openaiMessages,
						stream: true,
						stream_options: { include_usage: true },
					};
					requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

					// send chat request with retry
					const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
					logger.debug("request.body", { url, requestBody });
					const response = await sendWithSessionFallback(async () =>
						executeWithRetry(async () => {
							const res = await dispatchFetch(url, fetchInit({ ...requestHeaders }, requestBody));

							if (!res.ok) {
								const errorText = await res.text();
								console.error("[Custom OAI Provider] Custom OAI API error response", errorText);
								throwHttpError("Custom OAI API error", res, errorText, url);
							}

							return res;
						}, retryConfig)
					);

					if (!response.body) {
						throw new Error("No response body from Custom OAI API");
					}
					await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
					registerOpenCodeSessionIfNeeded();
				}
			} finally {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				cancelListener.dispose();
			}
		} catch (err) {
			console.error("[Custom OAI Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			logger.error("request.error", {
				modelId: model.id,
				messageCount: messages.length,
				errorName: err instanceof Error ? err.name : String(err),
				errorMessage: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			const durationMs = Date.now() - requestStartTime;
			logger.info("request.end", { modelId: model.id, durationMs });
			// Update last request time after successful completion
			this._lastRequestTime = Date.now();
		}
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 * @param useGenericKey If true, use generic API key.
	 * @param provider Optional provider name to get provider-specific API key.
	 */
	private async ensureApiKey(useGenericKey: boolean, provider?: string): Promise<string | undefined> {
		// Try to get provider-specific API key first
		let apiKey: string | undefined;
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.trim().toLowerCase();
			const providerKey = `oaicopilot.apiKey.${normalizedProvider}`;
			apiKey = await this.secrets.get(providerKey);

			if (!apiKey && !useGenericKey) {
				const entered = await vscode.window.showInputBox({
					title: `Custom OAI API Key for ${normalizedProvider}`,
					prompt: `Enter your Custom OAI API key for ${normalizedProvider}`,
					ignoreFocusOut: true,
					password: true,
				});
				if (entered && entered.trim()) {
					apiKey = entered.trim();
					await this.secrets.store(providerKey, apiKey);
				}
			}
		}

		// Fall back to generic API key
		if (!apiKey) {
			apiKey = await this.secrets.get("oaicopilot.apiKey");
		}

		if (!apiKey && useGenericKey) {
			const entered = await vscode.window.showInputBox({
				title: "Custom OAI API Key",
				prompt: "Enter your Custom OAI API key",
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("oaicopilot.apiKey", apiKey);
			}
		}
		return apiKey;
	}
}
