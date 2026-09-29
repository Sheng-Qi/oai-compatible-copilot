import * as assert from "assert";
import * as vscode from "vscode";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import {
	createResponsesReasoningPart,
	normalizeResponsesReasoningItem,
	parseResponsesReasoningPart,
} from "../openai/responsesState";
import { CommonApi } from "../commonApi";

function textMessage(role: number, text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: role as vscode.LanguageModelChatMessageRole,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	} as unknown as vscode.LanguageModelChatRequestMessage;
}

suite("ResponsesState", () => {
	test("round-trips encrypted reasoning through hidden parts", () => {
		const item = normalizeResponsesReasoningItem({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "encrypted-state",
			summary: [{ type: "summary_text", text: "thinking" }],
		});
		assert.ok(item);
		const part = createResponsesReasoningPart(item!);
		const parsed = parseResponsesReasoningPart(part);
		assert.deepStrictEqual(parsed, item);
	});

	test("rejects reasoning without encrypted state", () => {
		assert.strictEqual(
			normalizeResponsesReasoningItem({
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "thinking" }],
			}),
			null
		);
	});

	test("replays encrypted reasoning only on the OpenCode harness path", () => {
		const replay = normalizeResponsesReasoningItem({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "encrypted-state",
			summary: [{ type: "summary_text", text: "thinking" }],
		});
		assert.ok(replay);
		const messages = [
			{
				role: 2 as vscode.LanguageModelChatMessageRole,
				content: [createResponsesReasoningPart(replay!), new vscode.LanguageModelTextPart("done")],
				name: undefined,
			} as unknown as vscode.LanguageModelChatRequestMessage,
			textMessage(1, "next"),
		];
		const harness = new OpenaiResponsesApi("muse-spark-1.3-opencode", {
			harnessInput: true,
			includeEncryptedReasoning: true,
		});
		const input = harness.convertMessages(messages, { includeReasoningInRequest: false });
		const reasoning = input.find((item) => (item as { type?: string }).type === "reasoning") as unknown as Record<
			string,
			unknown
		>;
		assert.ok(reasoning);
		assert.strictEqual(reasoning.encrypted_content, "encrypted-state");
		assert.ok(!("id" in reasoning));

		const router = new OpenaiResponsesApi("glm-5.3-flash");
		const routerInput = router.convertMessages(messages, { includeReasoningInRequest: false });
		assert.strictEqual(
			routerInput.find((item) => (item as { type?: string }).type === "reasoning"),
			undefined
		);
	});

	test("emits harness-shaped input without volatile id/status only when enabled", () => {
		const toolCallMsg = {
			role: 2 as vscode.LanguageModelChatMessageRole,
			content: [
				new vscode.LanguageModelTextPart("working"),
				new vscode.LanguageModelToolCallPart("call_abc123", "run_in_terminal", { command: "ls" }),
			],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;
		const toolResultMsg = {
			role: 1 as vscode.LanguageModelChatMessageRole,
			content: [
				{
					callId: "call_abc123",
					content: [new vscode.LanguageModelTextPart("ok")],
				},
			],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;
		const harness = new OpenaiResponsesApi("muse-spark-1.3-opencode", { harnessInput: true });
		const input = harness.convertMessages([toolCallMsg, toolResultMsg, textMessage(1, "next")], {
			includeReasoningInRequest: false,
		});
		for (const item of input as unknown as Array<Record<string, unknown>>) {
			assert.ok(!("id" in item), `volatile id leaked: ${JSON.stringify(item).slice(0, 200)}`);
			assert.ok(!("status" in item), `volatile status leaked: ${JSON.stringify(item).slice(0, 200)}`);
		}

		const router = new OpenaiResponsesApi("glm-5.3-flash");
		const routerInput = router.convertMessages([textMessage(1, "hello")], { includeReasoningInRequest: false });
		const user = routerInput[0] as unknown as Record<string, unknown>;
		assert.strictEqual(user.status, "incomplete");
	});

	test("adds encrypted include only for OpenCode models", () => {
		const opencode = new OpenaiResponsesApi("muse-spark-1.3-opencode", {
			includeEncryptedReasoning: true,
		}).prepareRequestBody(
			{ model: "muse-spark-1.3-opencode", input: [], stream: true, reasoning: { effort: "xhigh" } },
			{
				id: "muse-spark-1.3-opencode",
				owned_by: "opencode",
				opencodeSession: true,
			}
		);
		assert.deepStrictEqual(opencode.include, ["reasoning.encrypted_content"]);

		const glm = new OpenaiResponsesApi("glm-5.3-flash").prepareRequestBody(
			{ model: "glm-5.3-flash", input: [], stream: true, reasoning: { effort: "max" } },
			{ id: "glm-5.3-flash", owned_by: "router" }
		);
		assert.strictEqual(glm.include, undefined);
	});

	test("rewrites extra.model and leaves router headers without OpenCode session", () => {
		const body = new OpenaiResponsesApi("muse-spark-1.3-opencode", {
			includeEncryptedReasoning: true,
		}).prepareRequestBody(
			{ model: "muse-spark-1.3-opencode", input: [], stream: true },
			{
				id: "muse-spark-1.3-opencode",
				owned_by: "opencode",
				extra: { model: "muse-spark-1.3-contributor", store: false },
			}
		);
		assert.strictEqual(body.model, "muse-spark-1.3-contributor");
		assert.strictEqual(body.store, false);

		const headers = CommonApi.prepareHeaders("sk-test", "openai-responses");
		assert.ok(!("x-opencode-session" in headers));
		assert.ok(!("x-opencode-client" in headers));
	});

	test("uses OpenCode headers and upstream thinking opt-in on completions", () => {
		const headers = CommonApi.prepareHeaders("sk-test", "openai", undefined, "ses_opencode_glm", {
			"x-opencode-client": "custom-oai-copilot",
		});
		assert.strictEqual(headers["x-opencode-session"], "ses_opencode_glm");
		assert.strictEqual(headers["x-opencode-client"], "custom-oai-copilot");
		assert.strictEqual(headers.Accept, "*/*");
		assert.ok(String(headers["User-Agent"]).startsWith("opencode-go-copilot/"));

		const body = new OpenaiApi("glm-5.3-flash").prepareRequestBody(
			{ model: "glm-5.3-flash", messages: [], stream: true },
			{
				id: "glm-5.3-flash",
				owned_by: "opencode",
				opencodeSession: true,
				enable_thinking: true,
				reasoning_effort: "max",
			}
		);
		assert.strictEqual(body.thinking, undefined);
		assert.strictEqual(body.reasoning_effort, "max");
		assert.strictEqual(body.enable_thinking, true);
	});

	test("omits thinking/enable_thinking by default (upstream opt-in)", () => {
		const body = new OpenaiApi("glm-5.3-flash").prepareRequestBody(
			{ model: "glm-5.3-flash", messages: [], stream: true },
			{
				id: "glm-5.3-flash",
				owned_by: "opencode",
				opencodeSession: true,
			}
		);
		assert.strictEqual(body.thinking, undefined);
		assert.strictEqual(body.enable_thinking, undefined);
	});
});
