import * as assert from "assert";
import * as vscode from "vscode";
import {
	AGENT_HOST_BYOK_SETTING,
	checkAgentHostReadiness,
	evaluateAgentHostReadiness,
	isAgentHostByokEnabled,
	setAgentHostByokEnabled,
} from "../agentHost";

suite("agentHost", () => {
	test("evaluates readiness without VS Code configuration", () => {
		assert.deepStrictEqual(evaluateAgentHostReadiness(0, false), {
			hasModels: false,
			modelCount: 0,
			byokEnabled: false,
			issues: ["No models configured in oaicopilot.models.", `${AGENT_HOST_BYOK_SETTING} is disabled.`],
		});
		assert.deepStrictEqual(evaluateAgentHostReadiness(2, false).issues, [
			`${AGENT_HOST_BYOK_SETTING} is disabled.`,
		]);
		assert.deepStrictEqual(evaluateAgentHostReadiness(2, true), {
			hasModels: true,
			modelCount: 2,
			byokEnabled: true,
			issues: [],
		});
	});

	test("reads readiness from workspace configuration", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const previousByok = config.get<boolean>(AGENT_HOST_BYOK_SETTING, false);
		try {
			await config.update(
				"oaicopilot.models",
				[{ id: "m1", owned_by: "p" }],
				vscode.ConfigurationTarget.Global
			);
			await setAgentHostByokEnabled(true);
			assert.strictEqual(isAgentHostByokEnabled(), true);
			const ready = checkAgentHostReadiness();
			assert.strictEqual(ready.hasModels, true);
			assert.strictEqual(ready.modelCount, 1);
			assert.deepStrictEqual(ready.issues, []);

			await setAgentHostByokEnabled(false);
			const blocked = checkAgentHostReadiness();
			assert.deepStrictEqual(blocked.issues, [`${AGENT_HOST_BYOK_SETTING} is disabled.`]);
		} finally {
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
			await config.update(AGENT_HOST_BYOK_SETTING, previousByok, vscode.ConfigurationTarget.Global);
		}
	});

	test("ignores __provider__ placeholder rows when counting models", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		try {
			await config.update(
				"oaicopilot.models",
				[{ id: "__provider__p", owned_by: "p" }],
				vscode.ConfigurationTarget.Global
			);
			const readiness = checkAgentHostReadiness();
			assert.strictEqual(readiness.modelCount, 0);
			assert.ok(readiness.issues.some((issue) => issue.includes("oaicopilot.models")));
		} finally {
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});
});
