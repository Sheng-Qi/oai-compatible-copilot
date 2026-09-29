import * as vscode from "vscode";

export class VersionManager {
	private static _version: string | null = null;

	/**
	 * Get the current extension version
	 */
	static getVersion(): string {
		if (this._version === null) {
			const extension = vscode.extensions.getExtension("custom.custom-oai-copilot");
			this._version = extension?.packageJSON?.version ?? "unknown";
		}
		return this._version!;
	}

	/**
	 * Build a descriptive User-Agent to help quantify API usage
	 * Keep UA minimal: only extension version and VS Code version
	 */
	static getUserAgent(): string {
		const vscodeVersion = vscode.version;
		return `custom-oai-copilot/${this.getVersion()} VSCode/${vscodeVersion}`;
	}

	/**
	 * User-Agent used for OpenCode Go/Zen inference. Matches OnesoftQwQ's
	 * plugin so Cloudflare/OpenCode session affinity and prompt cache keep
	 * treating this client as an OpenCode Go caller.
	 */
	static getOpenCodeUserAgent(): string {
		return `opencode-go-copilot/${this.getVersion()} VSCode/${vscode.version}`;
	}

	/**
	 * Get the current extension information
	 */
	static getClientInfo(): { name: string; version: string; author: string } {
		return {
			name: "custom-oai-copilot",
			version: this.getVersion(),
			author: "custom",
		};
	}
}
