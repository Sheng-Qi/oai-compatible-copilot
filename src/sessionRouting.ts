import * as crypto from "crypto";
import * as vscode from "vscode";

const MAX_SESSION_ENTRIES = 512;
const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = "customoaicopilot.sessionRouting.v1";

interface SessionEntry {
	sessionId: string;
	lastUsedAt: number;
}

const _sessions = new Map<string, SessionEntry>();
let _storage: vscode.Memento | undefined;

export function initSessionRouting(storage: vscode.Memento): void {
	_storage = storage;
	_sessions.clear();
	const stored = storage.get<Record<string, SessionEntry>>(STORAGE_KEY, {});
	const now = Date.now();
	for (const [anchor, entry] of Object.entries(stored ?? {})) {
		if (!entry || typeof entry.sessionId !== "string" || typeof entry.lastUsedAt !== "number") {
			continue;
		}
		if (now - entry.lastUsedAt > SESSION_TTL_MS) {
			continue;
		}
		_sessions.set(anchor, {
			sessionId: entry.sessionId,
			lastUsedAt: entry.lastUsedAt,
		});
	}
}

function persist(): void {
	if (!_storage) {
		return;
	}
	const snapshot: Record<string, SessionEntry> = {};
	for (const [anchor, entry] of _sessions) {
		snapshot[anchor] = { sessionId: entry.sessionId, lastUsedAt: entry.lastUsedAt };
	}
	void Promise.resolve(_storage.update(STORAGE_KEY, snapshot)).catch(() => undefined);
}

function extractText(content: ReadonlyArray<unknown>): string {
	let text = "";
	for (const part of content ?? []) {
		if (typeof part === "string") {
			text += part;
		} else if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}
	return text;
}

function isVolatileEnvText(text: string): boolean {
	// <environment_info>/<workspace_info> carry the live file listing which
	// changes whenever files are created/deleted. Hashing it makes the anchor
	// (and therefore prompt_cache_key/x-opencode-session) rotate on every
	// workspace change. Skip it; the real user query / <conversation-summary>
	// that follows is stable per conversation.
	return text.includes("<environment_info>") || text.includes("<workspace_info>");
}

function firstUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | null {
	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		const text = extractText(message.content ?? []);
		if (!text.trim()) {
			continue;
		}
		if (isVolatileEnvText(text)) {
			continue;
		}
		return text;
	}
	return null;
}

function firstAssistantText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | null {
	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		return extractText(message.content ?? []);
	}
	return null;
}

function anchorHash(modelId: string, userText: string, assistantText: string): string {
	const hash = crypto.createHash("sha256");
	hash.update(modelId);
	hash.update("\u0000");
	hash.update(userText);
	hash.update("\u0000");
	hash.update(assistantText);
	return hash.digest("hex");
}

function store(anchor: string, sessionId: string): void {
	_sessions.delete(anchor);
	_sessions.set(anchor, {
		sessionId,
		lastUsedAt: Date.now(),
	});
	while (_sessions.size > MAX_SESSION_ENTRIES) {
		const oldest = _sessions.keys().next().value as string | undefined;
		if (oldest === undefined) {
			break;
		}
		_sessions.delete(oldest);
	}
	persist();
}

export function resolveSessionId(
	modelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): { sessionId: string; registered: boolean } {
	const userText = firstUserText(messages);
	if (userText === null) {
		return { sessionId: crypto.randomUUID(), registered: false };
	}
	const assistantText = firstAssistantText(messages);
	if (assistantText === null) {
		return { sessionId: crypto.randomUUID(), registered: false };
	}
	const anchor = anchorHash(modelId, userText, assistantText);
	const existing = _sessions.get(anchor);
	if (existing) {
		if (Date.now() - existing.lastUsedAt > SESSION_TTL_MS) {
			_sessions.delete(anchor);
			persist();
			return { sessionId: crypto.randomUUID(), registered: false };
		}
		store(anchor, existing.sessionId);
		return {
			sessionId: existing.sessionId,
			registered: true,
		};
	}
	return { sessionId: crypto.randomUUID(), registered: false };
}

export function registerSessionId(
	modelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	turnOutput: string,
	sessionId: string
): void {
	const userText = firstUserText(messages);
	if (userText === null) {
		return;
	}
	const assistantText = firstAssistantText(messages) ?? turnOutput;
	store(anchorHash(modelId, userText, assistantText), sessionId);
}

export function rotateSessionId(modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const newId = crypto.randomUUID();
	const userText = firstUserText(messages);
	const assistantText = firstAssistantText(messages);
	if (userText !== null && assistantText !== null) {
		store(anchorHash(modelId, userText, assistantText), newId);
	}
	return newId;
}

export function isUpstreamProviderFailureError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	const statusMatch = message.match(/\[(\d{3})\]/);
	if (!statusMatch) {
		return false;
	}
	const status = Number(statusMatch[1]);
	if (status >= 500) {
		return true;
	}
	if (status !== 400) {
		return false;
	}
	const lower = message.toLowerCase();
	return lower.includes("api_error") && (lower.includes("upstream") || lower.includes("error from provider"));
}
