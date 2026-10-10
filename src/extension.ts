import * as vscode from "vscode";
import { CustomOaiChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { initSessionRouting } from "./sessionRouting";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { AGENT_HOST_BYOK_DOC_URL, checkAgentHostReadiness, setAgentHostByokEnabled } from "./agentHost";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();
	initSessionRouting(context.globalState);

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	const provider = new CustomOaiChatModelProvider(context.secrets, tokenCountStatusBarItem);
	context.subscriptions.push(provider);
	// Register the custom provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("custom-oaicopilot", provider);

	// Re-publish this vendor's models when endpoint settings change so the Agent
	// Host BYOK bridge (Agents window / Copilot harness, `chat.agentHost.byokModels.enabled`)
	// re-enumerates them without a window reload.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration("oaicopilot.models") ||
				e.affectsConfiguration("oaicopilot.baseUrl") ||
				e.affectsConfiguration("chat.agentHost.byokModels.enabled")
			) {
				provider.notifyModelsChanged();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.enableAgentHost", async () => {
			const readiness = checkAgentHostReadiness();
			if (!readiness.hasModels) {
				const openConfig = "Open Configuration UI";
				const choice = await vscode.window.showWarningMessage(
					"No models configured in oaicopilot.models. Configure models first, then enable Agent Host support.",
					openConfig
				);
				if (choice === openConfig) {
					await vscode.commands.executeCommand("custom-oaicopilot.openConfig");
				}
				return;
			}
			await setAgentHostByokEnabled(true);
			provider.notifyModelsChanged();
			const openModels = "Manage Language Models";
			const choice = await vscode.window.showInformationMessage(
				`Agent Host support enabled: ${readiness.modelCount} model(s) published via the BYOK bridge (chat.agentHost.byokModels.enabled). Pick them in the Agents window / Chat model picker.`,
				openModels
			);
			if (choice === openModels) {
				await vscode.commands.executeCommand("workbench.action.chat.manageLanguageModels");
			}
			logger.info("agentHost.enabled", { modelCount: readiness.modelCount });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.checkAgentHost", async () => {
			const readiness = checkAgentHostReadiness();
			if (readiness.issues.length === 0) {
				vscode.window.showInformationMessage(
					`Agent Host ready: ${readiness.modelCount} model(s) visible to Agents window / Copilot harness sessions. ` +
						`If a new model does not appear, start a Local session or re-pick the model; Cloud (remote coding agent) sessions cannot use local keys.`
				);
				logger.info("agentHost.ready", { modelCount: readiness.modelCount });
				return;
			}
			const enable = "Enable Agent Host Support";
			const docs = "Open BYOK Docs";
			const choice = await vscode.window.showWarningMessage(
				`Agent Host not ready: ${readiness.issues.join(" ")} See ${AGENT_HOST_BYOK_DOC_URL}`,
				enable,
				docs
			);
			if (choice === enable) {
				await vscode.commands.executeCommand("custom-oaicopilot.enableAgentHost");
			} else if (choice === docs) {
				await vscode.env.openExternal(vscode.Uri.parse(AGENT_HOST_BYOK_DOC_URL));
			}
			logger.warn("agentHost.notReady", { issues: readiness.issues });
		})
	);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "Custom OAI Provider API Key",
				prompt: existing ? "Update your Custom OAI API key" : "Enter your Custom OAI API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage("Custom OAI API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("Custom OAI API key saved.");
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in oaicopilot.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `Custom OAI API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("custom-oaicopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("oaicopilot.logLevel")) {
				logger.reloadConfig();
			}
		})
	);
}

export function deactivate() {}
