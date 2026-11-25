import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	createReasoningEffortConfigurationSchema,
	getConfiguredReasoningEffort,
	getGlobalServiceTier,
	isReasoningEffortPickerEnabled,
	isServiceTierValue,
	resolveServiceTier,
	type ModelPickerChatInformation,
	REASONING_EFFORT_CONFIGURATION_SCHEMA,
} from "../modelConfiguration";
import { OllamaApi } from "../ollama/ollamaApi";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { prepareLanguageModelChatInformation } from "../provideModel";
import type { HFModelItem } from "../types";

suite("modelConfiguration", () => {
	const deepSeekModel: HFModelItem = {
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		owned_by: "deepseek",
		baseUrl: "https://api.deepseek.com",
		apiMode: "openai",
		context_length: 1_000_000,
		max_tokens: 384_000,
		reasoning_effort: "medium",
	};

	test("only enables the picker when the model has a reasoning effort default", () => {
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "custom" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "high" }), true);
	});

	test("defines reasoning effort choices for provider configuration", () => {
		const schema = REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort;
		assert.strictEqual(schema.title, "Reasoning Effort");
		assert.strictEqual(schema.group, "navigation");
		assert.strictEqual(schema.default, "medium");
		assert.deepStrictEqual(schema.enum, ["minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.strictEqual(createReasoningEffortConfigurationSchema("high").properties.reasoningEffort.default, "high");
	});

	test("reads the selected reasoning effort from VS Code model configuration", () => {
		assert.strictEqual(getConfiguredReasoningEffort(undefined), "medium");
		assert.strictEqual(getConfiguredReasoningEffort(undefined, "low"), "low");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "high" } } as never),
			"high"
		);
		assert.strictEqual(getConfiguredReasoningEffort({ configuration: { reasoningEffort: "max" } } as never), "max");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "invalid" } } as never, "xhigh"),
			"xhigh"
		);
	});

	test("registers deepseek-v4-flash with reasoning effort metadata", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = { ...deepSeekModel, id: "deepseek-v4-flash", displayName: undefined };

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.name, "deepseek-v4-flash");
			assert.strictEqual(info.detail, "deepseek (CustomOAI)");
			assert.strictEqual(info.isUserSelectable, true);
			assert.deepStrictEqual(info.configurationSchema, createReasoningEffortConfigurationSchema("medium"));
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("does not register reasoning effort metadata when the default is empty", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			...deepSeekModel,
			id: "deepseek-v4-flash",
			displayName: undefined,
			reasoning_effort: undefined,
		};

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.configurationSchema, undefined);
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("applies selected reasoning effort to OpenAI-compatible chat requests", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			deepSeekModel,
			{ modelConfiguration: { reasoningEffort: "high" } } as never
		);

		assert.strictEqual(requestBody.reasoning_effort, "high");
	});

	test("falls back to the configured default reasoning effort when Copilot has no temporary override", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			{ ...deepSeekModel, reasoning_effort: "low" },
			undefined
		);

		assert.strictEqual(requestBody.reasoning_effort, "low");
	});

	test("applies selected reasoning effort to OpenAI Responses requests", () => {
		const requestBody = new OpenaiResponsesApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", input: [], stream: true },
			{ ...deepSeekModel, apiMode: "openai-responses" },
			{ modelConfiguration: { reasoningEffort: "max" } } as never
		);

		assert.deepStrictEqual(requestBody.reasoning, { effort: "max" });
	});

	test("validates global service tier values", () => {
		assert.strictEqual(isServiceTierValue("default"), true);
		assert.strictEqual(isServiceTierValue("fast"), true);
		assert.strictEqual(isServiceTierValue("standard"), false);
		assert.strictEqual(isServiceTierValue(""), false);
		assert.strictEqual(isServiceTierValue(undefined), false);
	});

	test("resolves the global service tier only for GPT-6+ models", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousTier = config.get<unknown>("oaicopilot.serviceTier", "default");
		try {
			await config.update("oaicopilot.serviceTier", "fast", vscode.ConfigurationTarget.Global);
			assert.strictEqual(getGlobalServiceTier(), "fast");
			assert.strictEqual(resolveServiceTier({ id: "gpt-6", owned_by: "openai" }), undefined);
			assert.strictEqual(resolveServiceTier({ id: "gpt-6.1-sol", owned_by: "openai", useGlobalServiceTier: true }), "fast");
			assert.strictEqual(resolveServiceTier({ id: "gpt-5.2", owned_by: "openai" }), undefined);
			assert.strictEqual(resolveServiceTier({ id: "deepseek-v4", owned_by: "deepseek" }), undefined);
			assert.strictEqual(resolveServiceTier(undefined), undefined);
		} finally {
			await config.update("oaicopilot.serviceTier", previousTier, vscode.ConfigurationTarget.Global);
		}
	});

	test("falls back to default tier when the global value is invalid", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousTier = config.get<unknown>("oaicopilot.serviceTier", "default");
		try {
			await config.update("oaicopilot.serviceTier", "bogus", vscode.ConfigurationTarget.Global);
			assert.strictEqual(getGlobalServiceTier(), "default");
		} finally {
			await config.update("oaicopilot.serviceTier", previousTier, vscode.ConfigurationTarget.Global);
		}
	});

	test("applies the global service tier to OpenAI-compatible chat requests", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousTier = config.get<unknown>("oaicopilot.serviceTier", "default");
		try {
			await config.update("oaicopilot.serviceTier", "fast", vscode.ConfigurationTarget.Global);
			const requestBody = new OpenaiApi("gpt-6").prepareRequestBody(
				{ model: "gpt-6", messages: [], stream: true },
				{ id: "gpt-6", owned_by: "openai", useGlobalServiceTier: true },
				undefined
			);
			assert.strictEqual(requestBody.service_tier, "fast");
		} finally {
			await config.update("oaicopilot.serviceTier", previousTier, vscode.ConfigurationTarget.Global);
		}
	});

	test("applies the global service tier to OpenAI Responses requests", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousTier = config.get<unknown>("oaicopilot.serviceTier", "default");
		try {
			await config.update("oaicopilot.serviceTier", "fast", vscode.ConfigurationTarget.Global);
			const requestBody = new OpenaiResponsesApi("gpt-6").prepareRequestBody(
				{ model: "gpt-6", input: [], stream: true },
				{ id: "gpt-6", owned_by: "openai", apiMode: "openai-responses", useGlobalServiceTier: true },
				undefined
			);
			assert.strictEqual(requestBody.service_tier, "fast");
		} finally {
			await config.update("oaicopilot.serviceTier", previousTier, vscode.ConfigurationTarget.Global);
		}
	});

	test("omits service tier from requests for non-GPT-6 models", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousTier = config.get<unknown>("oaicopilot.serviceTier", "default");
		try {
			await config.update("oaicopilot.serviceTier", "fast", vscode.ConfigurationTarget.Global);
			const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
				{ model: "deepseek-v4-pro", messages: [], stream: true },
				deepSeekModel,
				undefined
			);
			assert.strictEqual(requestBody.service_tier, undefined);
		} finally {
			await config.update("oaicopilot.serviceTier", previousTier, vscode.ConfigurationTarget.Global);
		}
	});

	test("lets extra.service_tier pin a single model over the global tier", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousTier = config.get<unknown>("oaicopilot.serviceTier", "default");
		try {
			await config.update("oaicopilot.serviceTier", "default", vscode.ConfigurationTarget.Global);
			const requestBody = new OpenaiApi("gpt-6").prepareRequestBody(
				{ model: "gpt-6", messages: [], stream: true },
				{ id: "gpt-6", owned_by: "openai", extra: { service_tier: "fast" } },
				undefined
			);
			assert.strictEqual(requestBody.service_tier, "fast");
		} finally {
			await config.update("oaicopilot.serviceTier", previousTier, vscode.ConfigurationTarget.Global);
		}
	});

	test("registers gpt-6 without a service tier picker", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			id: "gpt-6",
			owned_by: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai",
			reasoning_effort: "medium",
		};

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "gpt-6") as ModelPickerChatInformation | undefined;

			assert.ok(info, "gpt-6 should be registered");
			assert.strictEqual(info.tooltip, "openai (CustomOAI) · 128.0K context");
			assert.deepStrictEqual(info.configurationSchema, createReasoningEffortConfigurationSchema("medium"));
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("keeps the picker out of unsupported native API request bodies", () => {
		const options = { modelConfiguration: { reasoningEffort: "high" } } as never;
		const anthropicBody = new AnthropicApi("claude").prepareRequestBody(
			{ model: "claude", messages: [], max_tokens: 1024, stream: true },
			{ ...deepSeekModel, apiMode: "anthropic" },
			options
		) as unknown as Record<string, unknown>;
		const ollamaBody = new OllamaApi("qwen3").prepareRequestBody(
			{ model: "qwen3", messages: [], stream: true },
			{ ...deepSeekModel, apiMode: "ollama" },
			options
		) as unknown as Record<string, unknown>;
		const geminiBody = new GeminiApi("gemini").prepareRequestBody(
			{ contents: [] },
			{ ...deepSeekModel, apiMode: "gemini" },
			options
		) as Record<string, unknown>;

		assert.strictEqual(anthropicBody.reasoning_effort, undefined);
		assert.strictEqual(anthropicBody.thinking, undefined);
		assert.strictEqual(ollamaBody.reasoning_effort, undefined);
		assert.strictEqual(ollamaBody.think, undefined);
		assert.strictEqual(geminiBody.reasoning_effort, undefined);
		assert.strictEqual(geminiBody.thinkingConfig, undefined);
	});
});
