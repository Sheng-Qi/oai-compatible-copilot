import * as vscode from "vscode";
import { normalizeUserModels } from "./utils";

/** Workbench setting that publishes extension BYOK models into Agent Host (Agents window / Copilot harness) sessions. */
export const AGENT_HOST_BYOK_SETTING = "chat.agentHost.byokModels.enabled";

/** Doc URL for BYOK in the Agents window. */
export const AGENT_HOST_BYOK_DOC_URL =
	"https://code.visualstudio.com/docs/agent-customization/language-models#_bring-your-own-language-model-key";

export interface AgentHostReadiness {
	/** Whether at least one selectable model is configured in `oaicopilot.models`. */
	readonly hasModels: boolean;
	/** Number of selectable (non `__provider__`) models. */
	readonly modelCount: number;
	/** Whether `chat.agentHost.byokModels.enabled` is on. */
	readonly byokEnabled: boolean;
	/** Human-readable blockers; empty when ready. */
	readonly issues: string[];
}

/**
 * Pure evaluation helper (kept side-effect free for unit tests).
 */
export function evaluateAgentHostReadiness(modelCount: number, byokEnabled: boolean): AgentHostReadiness {
	const issues: string[] = [];
	if (modelCount <= 0) {
		issues.push("No models configured in oaicopilot.models.");
	}
	if (!byokEnabled) {
		issues.push(`${AGENT_HOST_BYOK_SETTING} is disabled.`);
	}
	return {
		hasModels: modelCount > 0,
		modelCount,
		byokEnabled,
		issues,
	};
}

/**
 * Read current readiness from VS Code configuration.
 * Extension models are auto-flagged `isBYOK` by the host (non-Copilot vendor),
 * so no per-model flag is needed here — only a configured model list plus the
 * Agent Host switch.
 */
export function checkAgentHostReadiness(): AgentHostReadiness {
	const config = vscode.workspace.getConfiguration();
	const models = normalizeUserModels(config.get<unknown>("oaicopilot.models", [])).filter(
		(m) => !m.id.startsWith("__provider__")
	);
	const byokEnabled = config.get<boolean>(AGENT_HOST_BYOK_SETTING, false);
	return evaluateAgentHostReadiness(models.length, byokEnabled);
}

/** Whether the Agent Host BYOK bridge switch is currently on. */
export function isAgentHostByokEnabled(): boolean {
	return vscode.workspace.getConfiguration().get<boolean>(AGENT_HOST_BYOK_SETTING, false);
}

/** Turn the Agent Host BYOK bridge switch on (global scope, no restart needed). */
export async function setAgentHostByokEnabled(enabled: boolean): Promise<void> {
	await vscode.workspace.getConfiguration().update(AGENT_HOST_BYOK_SETTING, enabled, vscode.ConfigurationTarget.Global);
}
