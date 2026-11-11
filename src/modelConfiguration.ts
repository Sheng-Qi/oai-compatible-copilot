import type * as vscode from "vscode";
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

export type ServiceTierPickerValue = "default" | "fast";

const SERVICE_TIER_VALUES: readonly ServiceTierPickerValue[] = ["default", "fast"];

// NOTE: VS Code renders at most one `configurationSchema` property per group
// (`getModelConfigProperty` returns the first match per group, with alias
// precedence for known keys). Reasoning effort already occupies the
// `navigation` (effort) slot, so the tier picker reuses the `tokens`
// (context) slot and both render side by side. Safe: context-window math
// only reads the literal `contextSize` key, and the context-size request
// override lives on the Copilot (CAPI) path, neither of which sees `serviceTier`.
export const SERVICE_TIER_CONFIGURATION_SCHEMA = {
	properties: {
		serviceTier: {
			type: "string",
			title: "Service Tier",
			enum: SERVICE_TIER_VALUES,
			enumItemLabels: ["Default", "Fast"],
			enumDescriptions: ["Standard pricing and performance", "Fast mode: lower latency at higher cost"],
			default: "default",
			group: "tokens",
		},
	},
} as const;

export function createServiceTierConfigurationSchema(defaultValue: ServiceTierPickerValue) {
	return {
		properties: {
			serviceTier: {
				...SERVICE_TIER_CONFIGURATION_SCHEMA.properties.serviceTier,
				default: defaultValue,
			},
		},
	} as const;
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
export function isGpt6OrNewer(model: HFModelItem | undefined): boolean {
	const id = model?.id?.trim() ?? "";
	const match = /^gpt-(\d+)/i.exec(id);
	if (!match) {
		return false;
	}
	return Number.parseInt(match[1], 10) >= 6;
}

export function isServiceTierPickerEnabled(
	model: HFModelItem | undefined
): model is HFModelItem & { service_tier: ServiceTierPickerValue } {
	return isGpt6OrNewer(model) && isServiceTierValue(model?.service_tier);
}

export function getConfiguredServiceTier(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined,
	fallback: ServiceTierPickerValue = "default"
): ServiceTierPickerValue {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configuredTier = modelOptions?.modelConfiguration?.serviceTier ?? modelOptions?.configuration?.serviceTier;

	if (isServiceTierValue(configuredTier)) {
		return configuredTier;
	}
	return fallback;
}

export function isServiceTierValue(value: unknown): value is ServiceTierPickerValue {
	return typeof value === "string" && SERVICE_TIER_VALUES.includes(value as ServiceTierPickerValue);
}
