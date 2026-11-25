import * as vscode from "vscode";
import type { HFModelItem } from "./types";

export type ReasoningEffortPickerValue = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES: readonly ReasoningEffortPickerValue[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const REASONING_EFFORT_CONFIGURATION_SCHEMA = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			enum: REASONING_EFFORT_VALUES,
			enumItemLabels: ["Minimal", "Low", "Medium", "High", "XHigh", "Max"],
			enumDescriptions: [
				"Smallest reasoning budget",
				"Low reasoning budget",
				"Balanced reasoning budget",
				"High reasoning budget",
				"Very high reasoning budget",
				"Maximum reasoning budget",
			],
			default: "medium",
			group: "navigation",
		},
	},
} as const;

export function createReasoningEffortConfigurationSchema(defaultValue: ReasoningEffortPickerValue) {
	return {
		properties: {
			reasoningEffort: {
				...REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort,
				default: defaultValue,
			},
		},
	} as const;
}

export type ServiceTierValue = "default" | "fast";

const SERVICE_TIER_VALUES: readonly ServiceTierValue[] = ["default", "fast"];

export function isServiceTierValue(value: unknown): value is ServiceTierValue {
	return typeof value === "string" && SERVICE_TIER_VALUES.includes(value as ServiceTierValue);
}

/**
 * Global service tier for OpenAI Chat Completions / Responses requests.
 * Read live from `oaicopilot.serviceTier` (default `"default"`) at request time,
 * so the Command Palette switch takes effect on the next request without a reload.
 * Per-machine/per-remote overrides via VS Code settings scopes are honored
 * because the merged configuration value is used.
 */
export function getGlobalServiceTier(): ServiceTierValue {
	const configured = vscode.workspace.getConfiguration().get<unknown>("oaicopilot.serviceTier", "default");
	return isServiceTierValue(configured) ? configured : "default";
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable?: boolean;
	readonly detail?: string;
	readonly tooltip?: string;
	readonly configurationSchema?: {
		readonly properties: Record<string, unknown>;
	};
};

export function createModelConfigurationSchema(
	schemas: ReadonlyArray<{ readonly properties: Record<string, unknown> }>
): { readonly properties: Record<string, unknown> } | undefined {
	if (schemas.length === 0) {
		return undefined;
	}
	const properties: Record<string, unknown> = {};
	for (const schema of schemas) {
		Object.assign(properties, schema.properties);
	}
	return { properties };
}

export function isReasoningEffortPickerEnabled(
	model: HFModelItem | undefined
): model is HFModelItem & { reasoning_effort: ReasoningEffortPickerValue } {
	return isReasoningEffortValue(model?.reasoning_effort);
}

export function getConfiguredReasoningEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined,
	fallback: ReasoningEffortPickerValue = "medium"
): ReasoningEffortPickerValue {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configuredEffort =
		modelOptions?.modelConfiguration?.reasoningEffort ?? modelOptions?.configuration?.reasoningEffort;

	if (isReasoningEffortValue(configuredEffort)) {
		return configuredEffort;
	}
	return fallback;
}

export function isReasoningEffortValue(value: unknown): value is ReasoningEffortPickerValue {
	return typeof value === "string" && REASONING_EFFORT_VALUES.includes(value as ReasoningEffortPickerValue);
}

/**
 * Whether the model is a GPT-6 (or newer major version) model, the only family
 * that currently supports the Fast service tier. Matches ids like `gpt-6`,
 * `gpt-6.1-sol`, `gpt-7-mini`.
 */
function isGpt6OrNewer(model: HFModelItem | undefined): boolean {
	const id = model?.id?.trim() ?? "";
	const match = /^gpt-(\d+)/i.exec(id);
	if (!match) {
		return false;
	}
	return Number.parseInt(match[1], 10) >= 6;
}

/**
 * Resolve the `service_tier` wire value for an OpenAI request, or `undefined`
 * to omit the parameter. Only GPT-6+ models get the global tier; everything
 * else is untouched so non-supporting models never see the parameter.
 */
export function resolveServiceTier(model: HFModelItem | undefined): ServiceTierValue | undefined {
	return model?.useGlobalServiceTier === true && isGpt6OrNewer(model) && getGlobalServiceTier() === "fast" ? "fast" : undefined;
}
