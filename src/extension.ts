import * as vscode from "vscode";
import { CustomOaiChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initServiceTierStatusBar, initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { initSessionRouting } from "./sessionRouting";
import { getGlobalServiceTier } from "./modelConfiguration";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();
	initSessionRouting(context.globalState);

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	initServiceTierStatusBar(context);
	const provider = new CustomOaiChatModelProvider(context.secrets, tokenCountStatusBarItem);
	context.subscriptions.push(provider);
	// Register the custom provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("custom-oaicopilot", provider);

	// Re-publish this vendor's models when endpoint settings change so consumers
	// (model picker, Agents window / Copilot harness via the built-in BYOK bridge)
	// re-enumerate them without a window reload.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("oaicopilot.models") || e.affectsConfiguration("oaicopilot.baseUrl")) {
				provider.notifyModelsChanged();
			}
		}),
		context.secrets.onDidChange(({ key }) => {
			if (key === "oaicopilot.apiKey" || key.startsWith("oaicopilot.apiKey.")) {
				provider.notifyModelsChanged();
			}
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

	// Switch the global OpenAI service tier (Standard / Fast) for GPT-6+ models.
	// Takes effect on the next request; per-machine overrides via settings scopes still win.
	context.subscriptions.push(
		vscode.commands.registerCommand("custom-oaicopilot.switchServiceTier", async () => {
			const current = getGlobalServiceTier();
			const picked = await vscode.window.showQuickPick(
				[
					{
						label: "Standard",
						description: "default",
						detail: "Standard pricing and performance",
						value: "default",
					},
					{
						label: "Fast",
						description: "fast",
						detail: "Lower latency at higher cost",
						value: "fast",
					},
				],
				{
					title: "Custom OAI Service Tier",
					placeHolder: `Current: ${current === "fast" ? "Fast" : "Standard"} — pick a tier for GPT-6+ models`,
				}
			);
			if (!picked) {
				return; // user canceled
			}
			await vscode.workspace
				.getConfiguration()
				.update("oaicopilot.serviceTier", picked.value, vscode.ConfigurationTarget.Global);
			const effective = getGlobalServiceTier();
			vscode.window.showInformationMessage(`Custom OAI effective service tier: ${effective === "fast" ? "Fast" : "Standard"} (opted-in models only).`);
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
