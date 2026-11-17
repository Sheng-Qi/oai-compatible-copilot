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

	test("replays encrypted reasoning for every Responses model", () => {
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
		const opencode = new OpenaiResponsesApi("muse-spark-1.3-opencode");
		const input = opencode.convertMessages(messages, { includeReasoningInRequest: false });
		const reasoning = input.find((item) => (item as { type?: string }).type === "reasoning") as unknown as Record<
			string,
			unknown
		>;
		assert.ok(reasoning);
		assert.strictEqual(reasoning.encrypted_content, "encrypted-state");
		assert.ok(!("id" in reasoning));

		const router = new OpenaiResponsesApi("glm-5.3-flash");
		const routerInput = router.convertMessages(messages, { includeReasoningInRequest: false });
		const routerReasoning = routerInput.find(
			(item) => (item as { type?: string }).type === "reasoning"
		) as unknown as Record<string, unknown>;
		assert.ok(routerReasoning);
		assert.strictEqual(routerReasoning.encrypted_content, "encrypted-state");
	});

	test("emits cache-stable input without volatile id/status for every model", () => {
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
		const harness = new OpenaiResponsesApi("muse-spark-1.3-opencode");
		const input = harness.convertMessages([toolCallMsg, toolResultMsg, textMessage(1, "next")], {
			includeReasoningInRequest: false,
		});
		for (const item of input as unknown as Array<Record<string, unknown>>) {
			assert.ok(!("id" in item), `volatile id leaked: ${JSON.stringify(item).slice(0, 200)}`);
			assert.ok(!("status" in item), `volatile status leaked: ${JSON.stringify(item).slice(0, 200)}`);
		}

		const router = new OpenaiResponsesApi("glm-5.3-flash");
		const routerInput = router.convertMessages([textMessage(1, "hello")], { includeReasoningInRequest: false });
		for (const item of routerInput as unknown as Array<Record<string, unknown>>) {
			assert.ok(!("id" in item), `volatile id leaked: ${JSON.stringify(item).slice(0, 200)}`);
			assert.ok(!("status" in item), `volatile status leaked: ${JSON.stringify(item).slice(0, 200)}`);
		}
	});

	test("keeps identical history byte-stable across conversions (prompt-cache prefix)", () => {
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
		const history = [textMessage(1, "hello"), toolCallMsg, toolResultMsg, textMessage(2, "done")];
		const first = new OpenaiResponsesApi("gpt-6.1-sol").convertMessages(history, {
			includeReasoningInRequest: false,
		});
		const second = new OpenaiResponsesApi("gpt-6.1-sol").convertMessages(history, {
			includeReasoningInRequest: false,
		});
		assert.strictEqual(JSON.stringify(second), JSON.stringify(first));
	});

	test("adds encrypted include for every Responses model", () => {
		const opencode = new OpenaiResponsesApi("muse-spark-1.3-opencode").prepareRequestBody(
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
		assert.deepStrictEqual(glm.include, ["reasoning.encrypted_content"]);
	});

	test("rewrites extra.model and leaves router headers without OpenCode session", () => {
		const body = new OpenaiResponsesApi("muse-spark-1.3-opencode").prepareRequestBody(
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
