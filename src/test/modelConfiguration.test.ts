import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	createModelConfigurationSchema,
	createReasoningEffortConfigurationSchema,
	createServiceTierConfigurationSchema,
	getConfiguredReasoningEffort,
	getConfiguredServiceTier,
	isGpt6OrNewer,
	isReasoningEffortPickerEnabled,
	isServiceTierPickerEnabled,
	type ModelPickerChatInformation,
	REASONING_EFFORT_CONFIGURATION_SCHEMA,
	SERVICE_TIER_CONFIGURATION_SCHEMA,
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

	test("only enables the service tier picker for GPT-6+ models", () => {
		assert.strictEqual(isGpt6OrNewer({ id: "gpt-5.2", owned_by: "openai" }), false);
		assert.strictEqual(isGpt6OrNewer({ id: "gpt-6", owned_by: "openai" }), true);
		assert.strictEqual(isGpt6OrNewer({ id: "gpt-6.1-sol", owned_by: "openai" }), true);
		assert.strictEqual(isGpt6OrNewer({ id: "gpt-7-mini", owned_by: "openai" }), true);
		assert.strictEqual(isGpt6OrNewer({ id: "deepseek-v4", owned_by: "deepseek" }), false);

		assert.strictEqual(isServiceTierPickerEnabled({ id: "gpt-6", owned_by: "openai" }), false);
		assert.strictEqual(isServiceTierPickerEnabled({ id: "gpt-6", owned_by: "openai", service_tier: "" }), false);
		assert.strictEqual(
			isServiceTierPickerEnabled({ id: "gpt-5.2", owned_by: "openai", service_tier: "default" }),
			false
		);
		assert.strictEqual(isServiceTierPickerEnabled({ id: "gpt-6", owned_by: "openai", service_tier: "default" }), true);
		assert.strictEqual(
			isServiceTierPickerEnabled({ id: "gpt-6.1-sol", owned_by: "openai", service_tier: "fast" }),
			true
		);
	});

	test("defines service tier choices for provider configuration", () => {
		const schema = SERVICE_TIER_CONFIGURATION_SCHEMA.properties.serviceTier;
		assert.strictEqual(schema.title, "Service Tier");
		assert.strictEqual(schema.default, "default");
		assert.deepStrictEqual(schema.enum, ["default", "fast"]);
		assert.strictEqual(createServiceTierConfigurationSchema("fast").properties.serviceTier.default, "fast");
	});

	test("reads the selected service tier from VS Code model configuration", () => {
		assert.strictEqual(getConfiguredServiceTier(undefined), "default");
		assert.strictEqual(getConfiguredServiceTier(undefined, "fast"), "fast");
		assert.strictEqual(getConfiguredServiceTier({ modelConfiguration: { serviceTier: "fast" } } as never), "fast");
		assert.strictEqual(getConfiguredServiceTier({ configuration: { serviceTier: "fast" } } as never), "fast");
		assert.strictEqual(
			getConfiguredServiceTier({ modelConfiguration: { serviceTier: "invalid" } } as never, "fast"),
			"fast"
		);
	});

	test("registers gpt-6 with both service tier and reasoning effort pickers", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			id: "gpt-6",
			owned_by: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai",
			service_tier: "default",
			reasoning_effort: "medium",
		};

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "gpt-6") as ModelPickerChatInformation | undefined;

			assert.ok(info, "gpt-6 should be registered");
			assert.deepStrictEqual(
				info.configurationSchema,
				createModelConfigurationSchema([
					createServiceTierConfigurationSchema("default"),
					createReasoningEffortConfigurationSchema("medium"),
				])
			);
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("does not register the service tier picker for pre-gpt-6 models", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			id: "gpt-5.2",
			owned_by: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai",
			service_tier: "default",
		};

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "gpt-5.2") as ModelPickerChatInformation | undefined;

			assert.ok(info, "gpt-5.2 should be registered");
			assert.strictEqual(info.configurationSchema, undefined);
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("applies the selected service tier to OpenAI-compatible chat requests", () => {
		const model: HFModelItem = { id: "gpt-6", owned_by: "openai", service_tier: "default" };
		const requestBody = new OpenaiApi("gpt-6").prepareRequestBody(
			{ model: "gpt-6", messages: [], stream: true },
			model,
			{ modelConfiguration: { serviceTier: "fast" } } as never
		);

		assert.strictEqual(requestBody.service_tier, "fast");
	});

	test("applies the selected service tier to OpenAI Responses requests", () => {
		const model: HFModelItem = {
			id: "gpt-6",
			owned_by: "openai",
			apiMode: "openai-responses",
			service_tier: "default",
		};
		const requestBody = new OpenaiResponsesApi("gpt-6").prepareRequestBody(
			{ model: "gpt-6", input: [], stream: true },
			model,
			{ modelConfiguration: { serviceTier: "fast" } } as never
		);

		assert.strictEqual(requestBody.service_tier, "fast");
	});

	test("falls back to the configured default service tier when Copilot has no temporary override", () => {
		const model: HFModelItem = { id: "gpt-6", owned_by: "openai", service_tier: "fast" };
		const requestBody = new OpenaiApi("gpt-6").prepareRequestBody(
			{ model: "gpt-6", messages: [], stream: true },
			model,
			undefined
		);

		assert.strictEqual(requestBody.service_tier, "fast");
	});

	test("omits service tier from requests when the model does not configure it", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			deepSeekModel,
			{ modelConfiguration: { serviceTier: "fast" } } as never
		);

		assert.strictEqual(requestBody.service_tier, undefined);
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
