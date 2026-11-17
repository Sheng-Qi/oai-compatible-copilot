import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";
import {
	getConfiguredReasoningEffort,
	isReasoningEffortPickerEnabled,
	resolveServiceTier,
} from "../modelConfiguration";
import type { OpenAIToolCall } from "./openaiTypes";

import {
	isImageMimeType,
	createDataUrl,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAIResponses,
	mapRole,
} from "../utils";

import { CommonApi } from "../commonApi";
import { logger } from "../logger";
import { OutputTextStreamNormalizer } from "./outputTextStreamNormalizer";
import {
	normalizeResponsesReasoningItem,
	parseResponsesReasoningPart,
	type ResponsesReasoningReplayItem,
} from "./responsesState";

export interface ResponsesInputMessage {
	role: "user" | "assistant" | "system";
	content: ResponsesContentPart[];
	type?: "message";
}

export interface ResponsesContentPart {
	type: "input_text" | "input_image" | "output_text" | "summary_text";
	text?: string;
	image_url?: string;
	detail?: "auto";
}

export interface ResponsesFunctionCall {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
}

export interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
}

export interface ResponsesReasoning {
	type: "reasoning";
	summary: ResponsesContentPart[];
	encrypted_content?: string | null;
}

export type ResponsesInputItem =
	| ResponsesInputMessage
	| ResponsesFunctionCall
	| ResponsesFunctionCallOutput
	| ResponsesReasoning;

export class OpenaiResponsesApi extends CommonApi<ResponsesInputItem, Record<string, unknown>> {
	private _responseId: string | null = null;
	private _responseCompleted = false;
	private readonly _outputTextStreamNormalizer = new OutputTextStreamNormalizer();
	private _capturedReasoningItems: ResponsesReasoningReplayItem[] = [];
	/** Set once any text/thinking/tool output reached the UI this stream. */
	private _streamProducedOutput = false;
	/** Endpoint of the in-flight stream, for error messages. Set by the provider. */
	private _lastStreamUrl: string | null = null;

	constructor(modelId: string) {
		super(modelId);
	}

	/** Record the request URL before streaming so stream errors can cite it. */
	set lastStreamUrl(url: string | null) {
		this._lastStreamUrl = url;
	}

	get responseId(): string | null {
		return this._responseId;
	}

	get responseCompleted(): boolean {
		return this._responseCompleted;
	}

	takeCapturedReasoningItems(): ResponsesReasoningReplayItem[] {
		const items = this._capturedReasoningItems;
		this._capturedReasoningItems = [];
		return items;
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ResponsesInputItem[] {
		const out: ResponsesInputItem[] = [];

		// Cache-safety: the input must be byte-stable across turns so the
		// provider's prompt-cache prefix matches. Never emit per-request ids,
		// timestamps, or status flips here — `id`/`status` are server-managed
		// output fields and client-generated values only poison the cache.
		for (const [messageIndex, m] of messages.entries()) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const thinkingParts: string[] = [];
			const reasoningReplays: ResponsesReasoningReplayItem[] = [];

			for (const part of m.content ?? []) {
				const reasoningReplay = parseResponsesReasoningPart(part);
				if (reasoningReplay) {
					reasoningReplays.push(reasoningReplay);
					continue;
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					// VS Code always assigns callIds; keep the fallback deterministic
					// (never random) so a missing id can't poison the cache prefix.
					const id = part.callId || `call_oaicopilot_${messageIndex}_${toolCalls.length}`;
					let args = "{}";
					try {
						args = JSON.stringify(part.input ?? {});
					} catch {
						args = "{}";
					}
					toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, content });
				} else if (part instanceof vscode.LanguageModelThinkingPart && modelConfig.includeReasoningInRequest) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			// assistant message (optional)
			if (role === "assistant") {
				for (const replay of reasoningReplays) {
					out.push({
						type: "reasoning",
						summary: replay.summary,
						encrypted_content: replay.encrypted_content,
					});
				}
				if (joinedText) {
					out.push({
						role: "assistant",
						content: [{ type: "output_text", text: joinedText }],
						type: "message",
					});
				}

				if (joinedThinking) {
					out.push({
						summary: [{ type: "summary_text", text: joinedThinking }],
						type: "reasoning",
					});
				}

				for (const tc of toolCalls) {
					out.push({
						type: "function_call",
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
					});
				}
			}

			// tool outputs
			for (const tr of toolResults) {
				if (!tr.callId) {
					continue;
				}
				out.push({
					type: "function_call_output",
					call_id: tr.callId,
					output: tr.content || "",
				});
			}

			// user message
			if (role === "user") {
				const contentArray: ResponsesContentPart[] = [];
				if (joinedText) {
					contentArray.push({ type: "input_text", text: joinedText });
				}
				for (const imagePart of imageParts) {
					const dataUrl = createDataUrl(imagePart);
					contentArray.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
				}
				if (contentArray.length > 0) {
					out.push({
						role: "user",
						content: contentArray,
						type: "message",
					});
				}
			}

			// system message (used to build `instructions` in request body)
			if (role === "system" && joinedText) {
				this._systemContent = joinedText;
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: Record<string, unknown>,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> {
		const isPlainObject = (v: unknown): v is Record<string, unknown> =>
			!!v && typeof v === "object" && !Array.isArray(v);

		// Add system content if we extracted it
		if (this._systemContent) {
			rb.instructions = this._systemContent;
		}

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// top_p
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// max_output_tokens
		if (um?.max_completion_tokens !== undefined) {
			rb.max_output_tokens = um.max_completion_tokens;
		} else if (um?.max_tokens !== undefined) {
			rb.max_output_tokens = um.max_tokens;
		}

		// OpenAI reasoning configuration
		if (isReasoningEffortPickerEnabled(um)) {
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort: getConfiguredReasoningEffort(options, um.reasoning_effort),
			};
		} else if (um?.reasoning_effort !== undefined) {
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort: um.reasoning_effort,
			};
		}

		// OpenAI service tier (global `oaicopilot.serviceTier`, GPT-6+ only).
		// A per-model escape hatch stays available via `extra: { service_tier }`,
		// which is merged below and overwrites this value.
		const serviceTier = resolveServiceTier(um);
		if (serviceTier !== undefined) {
			rb.service_tier = serviceTier;
		}

		// Always ask for encrypted reasoning so follow-up turns can replay it
		// for continuity (relays that don't support `include` ignore it).
		if (rb.include === undefined) {
			rb.include = ["reasoning.encrypted_content"];
		}

		// thinking (Volcengine provider)
		if (um?.thinking?.type !== undefined) {
			rb.thinking = {
				type: um.thinking.type,
			};
		}

		// stop
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		// tools
		const toolConfig = convertToolsToOpenAIResponses(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			rb.tool_choice = toolConfig.tool_choice;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					// Deep-merge reasoning config so `extra.reasoning` doesn't clobber `reasoning.effort`.
					if (key === "reasoning" && isPlainObject(value) && isPlainObject(rb.reasoning)) {
						rb.reasoning = { ...(rb.reasoning as Record<string, unknown>), ...(value as Record<string, unknown>) };
						continue;
					}
					if (key === "tools" && Array.isArray(value) && Array.isArray(rb.tools)) {
						rb.tools = [...rb.tools, ...value];
					} else {
						rb[key] = value;
					}
				}
			}
		}

		return rb;
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this._responseId = null;
		this._responseCompleted = false;
		this._capturedReasoningItems = [];
		this._streamProducedOutput = false;
		const modelId = this._modelId;
		logger.debug("responses.stream.start", { modelId });
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					logger.debug("responses.stream.chunk", { modelId, data });
					if (data === "[DONE]") {
						await this.flushToolCallBuffers(progress, false);
						continue;
					}

					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						await this.processEvent(parsed, progress);
					} catch (e) {
						if (e instanceof Error && e.message.startsWith("Responses API error:")) {
							throw e;
						}
						console.error("[OpenAI-Responses Provider] Failed to parse SSE chunk:", e, "data:", data);
						logger.error("responses.stream.chunk.error", {
							modelId,
							error: e instanceof Error ? e.message : String(e),
							data,
						});
					}
				}
			}
			logger.debug("responses.stream.done", { modelId, responseId: this._responseId ?? "" });
		} catch (e) {
			console.error("[OpenAI-Responses Provider] Streaming response error:", e);
			logger.error("responses.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			this.processOutputTextChunk(this._outputTextStreamNormalizer.flushPending(), progress);
			reader.releaseLock();
			this.reportEndThinking(progress);
			// Report accumulated usage for the Context Window widget
			this.reportUsage(progress);
		}

		// Guard against "successful" empty streams: some relays answer HTTP 200
		// with zero content events (e.g. after rejecting stateful chaining).
		// Surfacing an error here lets Copilot retry/show failure instead of
		// spinning on an empty turn. Cancellation is not an error.
		const emittedToolCall = this._completedToolCallIndices.size > 0 || this._toolCallBuffers.size > 0;
		if (!token.isCancellationRequested && !this._streamProducedOutput && !emittedToolCall && !this._responseCompleted) {
			const err = new Error(
				`Responses API error: stream ended without output (no text, thinking, or tool calls). URL: ${this._lastStreamUrl ?? "unknown"}`
			);
			(err as { status?: number }).status = 502;
			logger.error("responses.stream.empty", { modelId });
			throw err;
		}
	}

	private coerceText(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			if (typeof obj.text === "string") {
				return obj.text;
			}
			if (typeof obj.thinking === "string") {
				return obj.thinking;
			}
			if (typeof obj.reasoning === "string") {
				return obj.reasoning;
			}
			if (typeof obj.summary === "string") {
				return obj.summary;
			}
			if (typeof obj.value === "string") {
				return obj.value;
			}
		}
		return "";
	}

	private looksLikeReasoningConfigValue(value: string): boolean {
		const v = (value || "").trim().toLowerCase();
		return (
			v === "high" ||
			v === "medium" ||
			v === "low" ||
			v === "minimal" ||
			v === "auto" ||
			v === "none" ||
			v === "detailed" ||
			v === "concise"
		);
	}

	private processOutputTextChunk(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		if (!text) {
			return;
		}
		this._streamProducedOutput = true;
		// Process XML think blocks or text content (mutually exclusive)
		const xmlRes = this.processXmlThinkBlocks(text, progress);
		if (!xmlRes.emittedAny) {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			// Only process text content if no XML think blocks were emitted
			const res = this.processTextContent(text, progress);
			if (res.emittedAny) {
				this._hasEmittedAssistantText = true;
				this._hasEmittedText = true;
			}
		}
	}

	private async processEvent(
		event: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const eventType = typeof event.type === "string" ? event.type : "";
		if (!eventType) {
			// Some relays emit a bare `{"error": {...}}` payload without `type`.
			if (event.error && typeof event.error === "object") {
				this.throwStreamError(event);
			}
			return;
		}

		this.captureResponseIdFromEvent(event);

		switch (eventType) {
			case "error": {
				// Relays may answer HTTP 200 with an in-stream error payload instead
				// of a 4xx (e.g. rejecting `previous_response_id`). Never swallow it:
				// surface it so the provider can fall back instead of spinning on an
				// empty turn.
				this.throwStreamError(event);
				return;
			}

			// Output text delta events
			case "response.output_text.delta":
			case "response.refusal.delta": {
				this._hasEmittedText = false;
				const delta = this._outputTextStreamNormalizer.normalize(this.coerceText(event.delta));
				this.processOutputTextChunk(delta, progress);
				return;
			}

			// Output text done events
			case "response.output_text.done": {
				// Some gateways only emit a final "done" payload (no deltas).
				if (this._hasEmittedText) {
					this._hasEmittedText = false;
					return;
				}
				const text = this.coerceText(event.text);
				this.processOutputTextChunk(text, progress);
				return;
			}
			case "response.refusal.done": {
				return;
			}

			// Reasoning delta events
			case "response.reasoning.delta":
			case "response.reasoning_text.delta":
			case "response.reasoning_summary.delta":
			case "response.reasoning_summary_text.delta":
			case "response.thinking.delta":
			case "response.thinking_summary.delta":
			case "response.thought.delta":
			case "response.thought_summary.delta": {
				this._hasEmittedThinking = false;
				this.processReasoningText(event, progress);
				return;
			}

			// Reasoning done events
			case "response.reasoning.done":
			case "response.reasoning_text.done":
			case "response.reasoning_summary.done":
			case "response.reasoning_summary_text.done":
			case "response.thinking.done":
			case "response.thinking_summary.done":
			case "response.thought.done":
			case "response.thought_summary.done": {
				if (this._hasEmittedThinking) {
					this.reportEndThinking(progress);
					this._hasEmittedThinking = false;
					return;
				}

				this.processReasoningText(event, progress);
				this.reportEndThinking(progress);
				return;
			}

			// Tool call events
			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done": {
				this.reportEndThinking(progress);

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const callId = this.getCallIdFromEvent(event);
				const name = typeof event.name === "string" ? event.name : "";
				const chunk =
					eventType === "response.function_call_arguments.delta"
						? typeof event.delta === "string"
							? event.delta
							: ""
						: typeof event.arguments === "string"
							? event.arguments
							: "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) {
					buf.id = callId;
				}
				if (!buf.name && name) {
					buf.name = name;
				}

				if (eventType === "response.function_call_arguments.delta") {
					if (chunk) buf.args += chunk;
				} else {
					// "done" events typically provide the full argument string.
					buf.args = chunk;
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType === "response.function_call_arguments.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.output_item.added":
			case "response.output_item.done": {
				const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
				if (!item) {
					return;
				}
				if (item.type === "reasoning") {
					// Capture-only: the provider reports the hidden part once and
					// persists the item for next-turn replay.
					const replay = normalizeResponsesReasoningItem(item);
					if (replay) {
						this._capturedReasoningItems.push(replay);
					}
					this.reportEndThinking(progress);
					return;
				}
				if (item.type !== "function_call") {
					return;
				}

				this.reportEndThinking(progress);

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) {
					return;
				}

				const callId = this.getCallIdFromEvent(item);
				const name =
					typeof item.name === "string"
						? item.name
						: item.function &&
							  typeof item.function === "object" &&
							  typeof (item.function as Record<string, unknown>).name === "string"
							? String((item.function as Record<string, unknown>).name)
							: "";
				const args =
					typeof item.arguments === "string"
						? item.arguments
						: item.function &&
							  typeof item.function === "object" &&
							  typeof (item.function as Record<string, unknown>).arguments === "string"
							? String((item.function as Record<string, unknown>).arguments)
							: "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) {
					buf.id = callId;
				}
				if (!buf.name && name) {
					buf.name = name;
				}
				if (args) {
					buf.args = args;
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType == "response.output_item.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.completed":
			case "response.done": {
				// End of message - ensure thinking is ended and flush all tool calls
				await this.flushToolCallBuffers(progress, false);
				this.reportEndThinking(progress);
				this._responseCompleted = true;
				// Capture usage from the completed event
				const usage = event.usage ?? (event.response as Record<string, unknown>)?.usage;
				if (usage && typeof usage === "object") {
					const u = usage as Record<string, unknown>;
					this._usage = {
						prompt_tokens: Number(u.input_tokens ?? 0),
						completion_tokens: Number(u.output_tokens ?? 0),
						total_tokens: Number(u.total_tokens ?? 0),
						prompt_tokens_details: u.input_tokens_details
							? { cached_tokens: Number((u.input_tokens_details as Record<string, unknown>).cached_tokens ?? 0) }
							: undefined,
					};
					logger.debug("usage.capture", { modelId: this._modelId, usage: this._usage });
				}
				return;
			}
			case "response.incomplete": {
				this._responseCompleted = false;
				return;
			}
			case "response.failed": {
				this._responseCompleted = false;
				this.throwStreamError(event);
				return;
			}
		}
	}

	/**
	 * Raise an in-stream failure as a `Responses API error` so callers can
	 * distinguish it from parse noise (which stays non-fatal). Status 502
	 * marks "upstream answered 200 but reported failure".
	 */
	private throwStreamError(event: Record<string, unknown>): never {
		const errorText = JSON.stringify(event);
		console.error("[Custom OAI Provider] Responses API streaming process error:", errorText);
		logger.error("responses.stream.event.error", { modelId: this._modelId, error: errorText });
		const err = new Error(`Responses API error: ${errorText}\nURL: ${this._lastStreamUrl ?? "unknown"}`);
		(err as { status?: number }).status = 502;
		throw err;
	}

	private captureResponseIdFromEvent(event: Record<string, unknown>): void {
		if (this._responseId) {
			return;
		}

		const responseId = event.response_id;
		if (typeof responseId === "string" && responseId.trim()) {
			this._responseId = responseId;
			return;
		}

		const response = event.response;
		if (response && typeof response === "object" && !Array.isArray(response)) {
			const id = (response as Record<string, unknown>).id;
			if (typeof id === "string" && id.trim()) {
				this._responseId = id;
			}
		}
	}

	private processReasoningText(
		event: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>
	) {
		const candidates = [
			this.coerceText(event.delta),
			this.coerceText(event.text),
			this.coerceText((event as Record<string, unknown>).reasoning),
			this.coerceText((event as Record<string, unknown>).summary),
		].filter(Boolean);

		for (const chunk of candidates) {
			if (this.looksLikeReasoningConfigValue(chunk)) {
				continue;
			}
			this._streamProducedOutput = true;
			this.bufferThinkingContent(chunk, progress);
			break;
		}
	}

	private getCallIdFromEvent(event: Record<string, unknown>): string {
		const callIdRaw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
		return typeof callIdRaw === "string" ? callIdRaw : "";
	}

	async *createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string,
		dispatchFetch?: typeof fetch
	): AsyncGenerator<{ type: "text"; text: string }> {
		// Convert to Responses API format
		const input: ResponsesInputItem[] = [];

		// Add system prompt as a system message or via instructions
		if (systemPrompt) {
			input.push({
				role: "system",
				content: [{ type: "input_text", text: systemPrompt }],
				type: "message",
			});
		}

		// Add user/assistant messages
		for (const msg of messages) {
			const role = msg.role === "user" || msg.role === "assistant" || msg.role === "system" ? msg.role : "user";
			input.push({
				role,
				content: [{ type: "input_text", text: msg.content }],
				type: "message",
			});
		}

		// Build request body
		let requestBody: Record<string, unknown> = {
			model: model.id,
			input,
			stream: true,
		};

		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai-responses", model.headers);

		const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

		// Make the API request
		const doFetch = dispatchFetch ?? fetch;
		const response = await doFetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI Responses API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from OpenAI Responses API");
		}

		// Process SSE streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === "[DONE]") continue;

					try {
						const parsed = JSON.parse(data);
						const eventType = typeof parsed.type === "string" ? parsed.type : "";

						// Only handle text output events, skip reasoning/thinking events
						const textOutputEvents = ["response.output_text.delta"];

						const isTextEvent = textOutputEvents.includes(eventType) || !eventType; // Also support events without explicit type

						if (isTextEvent) {
							// Extract text from various possible locations
							const textSources = [parsed.delta, parsed.text, parsed.content, parsed.output?.[0]?.content?.[0]?.text];

							for (const textSource of textSources) {
								if (typeof textSource === "string" && textSource) {
									yield { type: "text", text: textSource };
									break;
								}
							}
						}

						// Check for completion
						if (parsed.done || parsed.type === "response.completed" || parsed.type === "response.done") {
							break;
						}
					} catch (e) {
						console.error("[OpenAI-Responses Provider] Failed to parse SSE chunk:", e, "data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}
