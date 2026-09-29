import * as assert from "assert";
import * as vscode from "vscode";
import { initSessionRouting, registerSessionId, resolveSessionId } from "../sessionRouting";

function textMessage(role: number, text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: role as vscode.LanguageModelChatMessageRole,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	} as unknown as vscode.LanguageModelChatRequestMessage;
}

suite("SessionRouting", () => {
	test("keeps one session across turns of one conversation", () => {
		const storage = {
			get: () => ({}),
			update: async () => undefined,
		} as unknown as vscode.Memento;
		initSessionRouting(storage);
		const first = [textMessage(1, "hello")];
		const fresh = resolveSessionId("muse-spark-1.3-opencode", first);
		assert.strictEqual(fresh.registered, false);
		registerSessionId("muse-spark-1.3-opencode", first, "hi there", fresh.sessionId);
		const second = [textMessage(1, "hello"), textMessage(2, "hi there"), textMessage(1, "again")];
		const reused = resolveSessionId("muse-spark-1.3-opencode", second);
		assert.strictEqual(reused.registered, true);
		assert.strictEqual(reused.sessionId, fresh.sessionId);
	});

	test("isolates conversations that share an opening message", () => {
		const storage = {
			get: () => ({}),
			update: async () => undefined,
		} as unknown as vscode.Memento;
		initSessionRouting(storage);
		const first = [textMessage(1, "same opener")];
		const sessionA = resolveSessionId("muse-spark-1.3-opencode", first);
		registerSessionId("muse-spark-1.3-opencode", first, "answer A", sessionA.sessionId);
		const other = [textMessage(1, "same opener"), textMessage(2, "answer B"), textMessage(1, "follow up")];
		const sessionB = resolveSessionId("muse-spark-1.3-opencode", other);
		assert.strictEqual(sessionB.registered, false);
		assert.notStrictEqual(sessionB.sessionId, sessionA.sessionId);
	});

	test("ignores volatile environment prefix when anchoring", () => {
		const storage = {
			get: () => ({}),
			update: async () => undefined,
		} as unknown as vscode.Memento;
		initSessionRouting(storage);
		const envA = textMessage(
			1,
			"<environment_info>\nOS: Linux\n</environment_info>\n<workspace_info>\nA\n</workspace_info>"
		);
		const first = [envA];
		const fresh = resolveSessionId("muse-spark-1.3-opencode", first);
		assert.strictEqual(fresh.registered, false);
		const realFirst = [envA, textMessage(1, "hello")];
		const anchored = resolveSessionId("muse-spark-1.3-opencode", realFirst);
		assert.strictEqual(anchored.registered, false);
		registerSessionId("muse-spark-1.3-opencode", realFirst, "hi there", anchored.sessionId);
		const envB = textMessage(
			1,
			"<environment_info>\nOS: Linux\n</environment_info>\n<workspace_info>\nA\nB\n</workspace_info>"
		);
		const second = [envB, textMessage(1, "hello"), textMessage(2, "hi there"), textMessage(1, "again")];
		const reused = resolveSessionId("muse-spark-1.3-opencode", second);
		assert.strictEqual(reused.registered, true);
		assert.strictEqual(reused.sessionId, anchored.sessionId);
	});
});
