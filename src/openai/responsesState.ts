import * as vscode from "vscode";

export const RESPONSES_REASONING_MIME = "application/vnd.custom-oaicopilot.responses-reasoning+json";

export interface ResponsesReasoningReplayItem {
	type: "reasoning";
	id: string;
	summary: Array<{ type: "summary_text"; text: string }>;
	encrypted_content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeResponsesReasoningItem(item: unknown): ResponsesReasoningReplayItem | null {
	if (!isRecord(item)) {
		return null;
	}
	if (item.type !== "reasoning" || typeof item.id !== "string" || item.id.length === 0) {
		return null;
	}
	if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
		return null;
	}
	if (!Array.isArray(item.summary)) {
		return null;
	}
	const summary = (item.summary as unknown[]).filter(
		(part): part is { type: "summary_text"; text: string } =>
			isRecord(part) && part.type === "summary_text" && typeof part.text === "string"
	);
	return {
		type: "reasoning",
		id: item.id,
		summary,
		encrypted_content: item.encrypted_content,
	};
}

export function createResponsesReasoningPart(item: ResponsesReasoningReplayItem): vscode.LanguageModelDataPart {
	const payload = { version: 1, item };
	return new vscode.LanguageModelDataPart(
		new TextEncoder().encode(JSON.stringify(payload)),
		RESPONSES_REASONING_MIME
	);
}

export function parseResponsesReasoningPart(part: unknown): ResponsesReasoningReplayItem | null {
	if (!(part instanceof vscode.LanguageModelDataPart) || part.mimeType !== RESPONSES_REASONING_MIME) {
		return null;
	}
	try {
		const payload = JSON.parse(new TextDecoder().decode(part.data)) as unknown;
		if (!isRecord(payload) || payload.version !== 1 || !isRecord(payload.item)) {
			return null;
		}
		return normalizeResponsesReasoningItem(payload.item);
	} catch {
		return null;
	}
}
