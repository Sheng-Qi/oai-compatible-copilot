import * as net from "net";
import { parseModelProxy, ParsedProxy } from "./httpClient";

/**
 * A named proxy profile from the `oaicopilot.proxies` setting.
 * `url` may be empty, meaning "direct connect" (no proxy).
 */
export interface ProxyProfile {
	/** Unique profile name referenced by proxy specs. */
	name: string;
	/** HTTP/SOCKS proxy URL, or empty string for direct connect. */
	url: string;
	/**
	 * Optional environment filter following `vscode.env.remoteName`:
	 * - "local" matches non-remote windows, "remote" matches any remote window,
	 * - any other value prefix-matches the remoteName (e.g. "ssh", "wsl").
	 * Omitted (or empty) means the profile applies everywhere.
	 */
	useIn?: string[];
}

/**
 * A resolved proxy candidate used by failover selection.
 * `kind === "direct"` means "connect without a proxy".
 */
export type ParsedProxyEntry =
	| { kind: "direct"; label: string }
	| { kind: "proxy"; label: string; raw: string; proxy: ParsedProxy };

export interface ProxyResolution {
	/** Ordered candidate entries (after environment filtering). */
	entries: ParsedProxyEntry[];
	/** Non-fatal notes about dropped/invalid tokens (surface via logging). */
	warnings: string[];
}

export interface NormalizeProxyProfilesResult {
	profiles: ProxyProfile[];
	warnings: string[];
}

/** Keyword that forces a direct (non-proxied) connection inside a proxy spec. */
export const DIRECT_PROXY_KEYWORD = "direct";

/** Default TCP connect timeout (ms) used when probing failover candidates. */
export const PROXY_PROBE_DEFAULT_TIMEOUT_MS = 2000;

/** Separator characters allowed inside a proxy spec. */
const PROXY_SPEC_SEPARATOR = /[\s,;|]+/;

/**
 * Normalize the raw `oaicopilot.proxies` setting into validated profiles.
 * Invalid entries are dropped with a warning; duplicate names keep the first.
 * @param raw Raw value from configuration.
 */
export function normalizeProxyProfiles(raw: unknown): NormalizeProxyProfilesResult {
	const warnings: string[] = [];
	const profiles: ProxyProfile[] = [];
	const seenNames = new Set<string>();

	if (raw === undefined || raw === null) {
		return { profiles, warnings };
	}
	if (!Array.isArray(raw)) {
		warnings.push("`oaicopilot.proxies` must be an array of {name, url, useIn?} objects; value ignored.");
		return { profiles, warnings };
	}

	raw.forEach((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			warnings.push(`proxies[${index}] is not an object; skipped.`);
			return;
		}
		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		if (!name) {
			warnings.push(`proxies[${index}] is missing a non-empty "name"; skipped.`);
			return;
		}
		if (typeof obj.url !== "string") {
			warnings.push(`proxies[${index}] ("${name}") is missing "url" as string; skipped.`);
			return;
		}
		if (seenNames.has(name.toLowerCase())) {
			warnings.push(`proxies[${index}] ("${name}") duplicates an earlier profile name; first one wins.`);
			return;
		}
		let useIn: string[] | undefined;
		if (obj.useIn !== undefined) {
			if (Array.isArray(obj.useIn)) {
				useIn = obj.useIn.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length > 0);
				if (useIn.length === 0) {
					useIn = undefined;
				}
			} else {
				warnings.push(
					`proxies[${index}] ("${name}") has invalid "useIn" (must be an array of strings); filter dropped.`
				);
				useIn = undefined;
			}
		}
		seenNames.add(name.toLowerCase());
		profiles.push({ name, url: obj.url.trim(), ...(useIn ? { useIn } : {}) });
	});

	return { profiles, warnings };
}

/**
 * Check whether a profile's `useIn` filter matches the current environment.
 * @param useIn Environment tokens (`local`, `remote`, remoteName prefixes) or undefined.
 * @param remoteName `vscode.env.remoteName` for the current window (undefined in local windows).
 */
export function matchesProxyEnvironment(useIn: string[] | undefined, remoteName: string | undefined): boolean {
	if (!useIn || useIn.length === 0) {
		return true;
	}
	if (!remoteName) {
		return useIn.includes("local");
	}
	const lowerRemoteName = remoteName.toLowerCase();
	for (const token of useIn) {
		if (token === "remote") {
			return true;
		}
		if (token === "local") {
			continue;
		}
		if (lowerRemoteName.startsWith(token)) {
			return true;
		}
	}
	return false;
}

/**
 * Split a proxy spec into tokens. Tokens are separated by whitespace, commas,
 * semicolons or pipes: `"a, http://x:1 ; b" -> ["a", "http://x:1", "b"]`.
 * @param spec Raw spec value (string).
 */
export function splitProxySpec(spec: string): string[] {
	return spec.split(PROXY_SPEC_SEPARATOR).filter((token) => token.length > 0);
}

/**
 * Stable identity used when comparing candidates across requests (probe cache).
 * @param entry Proxy candidate entry.
 */
export function proxyEntryIdentity(entry: ParsedProxyEntry): string {
	return entry.kind === "direct" ? DIRECT_PROXY_KEYWORD : entry.raw;
}

function buildEntryFromUrl(label: string, url: string, warnings: string[]): ParsedProxyEntry | undefined {
	const raw = (url ?? "").trim();
	try {
		const proxy = parseModelProxy(raw || undefined);
		if (!proxy) {
			return { kind: "direct", label };
		}
		return { kind: "proxy", label, raw, proxy };
	} catch (err) {
		warnings.push(err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

/**
 * Resolve a proxy spec (tokens) into an ordered candidate list.
 * Tokens can be: the keyword `direct`, a profile name, or a raw proxy URL.
 * Profiles whose `useIn` filter excludes the current environment are dropped.
 * @param spec Proxy spec string (may be empty/whitespace).
 * @param profiles Proxy registry from `oaicopilot.proxies`.
 * @param remoteName Current `vscode.env.remoteName` (optional).
 */
export function resolveProxyEntries(
	spec: unknown,
	profiles: ProxyProfile[],
	remoteName: string | undefined
): ProxyResolution {
	const warnings: string[] = [];
	const tokens = typeof spec === "string" ? splitProxySpec(spec) : [];
	if (tokens.length === 0) {
		return { entries: [], warnings };
	}

	const entries: ParsedProxyEntry[] = [];
	const byName = new Map<string, ProxyProfile>();
	for (const profile of profiles) {
		byName.set(profile.name.toLowerCase(), profile);
	}

	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (lower === DIRECT_PROXY_KEYWORD || lower === "none") {
			entries.push({ kind: "direct", label: DIRECT_PROXY_KEYWORD });
			continue;
		}
		const profile = byName.get(lower);
		if (profile) {
			if (!matchesProxyEnvironment(profile.useIn, remoteName)) {
				warnings.push(`proxy profile "${profile.name}" is not available in this environment (filtered by useIn).`);
				continue;
			}
			const entry = buildEntryFromUrl(profile.name, profile.url, warnings);
			if (entry) {
				entries.push(entry);
			}
			continue;
		}
		const entry = buildEntryFromUrl(token, token, warnings);
		if (entry) {
			entries.push(entry);
		}
	}

	return { entries, warnings };
}

/**
 * Auto-selection: the first profile whose `useIn` matches the current environment.
 * @param profiles Proxy registry.
 * @param remoteName Current `vscode.env.remoteName` (optional).
 */
export function resolveAutoProxyEntries(profiles: ProxyProfile[], remoteName: string | undefined): ProxyResolution {
	const warnings: string[] = [];
	for (const profile of profiles) {
		if (!matchesProxyEnvironment(profile.useIn, remoteName)) {
			continue;
		}
		const entry = buildEntryFromUrl(profile.name, profile.url, warnings);
		if (entry) {
			return { entries: [entry], warnings };
		}
	}
	return { entries: [], warnings };
}

/**
 * Resolve the effective proxy candidates for one model request.
 *
 * Priority:
 * 1. per-model spec (`models[].proxy`) when it resolves to at least one usable entry,
 * 2. global spec (`oaicopilot.proxy`) when it resolves to at least one usable entry,
 * 3. auto: first profile whose `useIn` matches the current environment,
 * 4. direct (no proxy).
 *
 * @param modelSpec Per-model proxy spec (string, may be undefined).
 * @param globalSpec Global `oaicopilot.proxy` value.
 * @param profiles Proxy registry.
 * @param remoteName Current `vscode.env.remoteName` (optional).
 */
export function resolveProxyForModel(
	modelSpec: unknown,
	globalSpec: unknown,
	profiles: ProxyProfile[],
	remoteName: string | undefined
): ProxyResolution {
	const modelSpecStr = typeof modelSpec === "string" ? modelSpec.trim() : "";
	if (modelSpecStr) {
		const resolved = resolveProxyEntries(modelSpecStr, profiles, remoteName);
		if (resolved.entries.length > 0) {
			return resolved;
		}
	}

	const globalSpecStr = typeof globalSpec === "string" ? globalSpec.trim() : "";
	if (globalSpecStr) {
		const resolved = resolveProxyEntries(globalSpecStr, profiles, remoteName);
		if (resolved.entries.length > 0) {
			return resolved;
		}
	}

	return resolveAutoProxyEntries(profiles, remoteName);
}

/**
 * Parse and validate a JSON string written in the configuration UI
 * for `oaicopilot.proxies`.
 * @param raw JSON text (may be empty).
 */
export function parseProxyProfilesJson(
	raw: string
): { ok: true; value: ProxyProfile[] } | { ok: false; error: string } {
	if (!raw || !raw.trim()) {
		return { ok: true, value: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `Invalid proxy profiles JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	const result = normalizeProxyProfiles(parsed);
	return { ok: true, value: result.profiles };
}

export interface ProxySelectionResult {
	/** Chosen candidate, or undefined when the candidate list was empty (direct). */
	entry: ParsedProxyEntry | undefined;
	/** Human-readable probe failure per skipped candidate. */
	probeFailures: string[];
}

/** How long a probe-based selection is reused for identical candidate lists. */
const PROBE_SELECTION_CACHE_TTL_MS = 60_000;
const probeSelectionCache = new Map<string, { identity: string; at: number }>();

/**
 * Pick the candidate to use, honoring order with a failover probe.
 *
 * Behavior:
 * - empty list -> no proxy (undefined);
 * - single candidate -> returned as-is (no probe overhead);
 * - `probeTimeoutMs <= 0` -> probing disabled, `direct` beats other candidates
 *   without probing and the first proxy wins otherwise;
 * - multiple candidates -> TCP-connect each proxy in order and pick the first
 *   alive; a `direct` keyword entry wins as soon as it is reached;
 * - nothing reachable -> fall back to the first candidate so the request
 *   surfaces a regular connection error instead of silently going direct.
 *
 * Successful selections are cached per identical candidate list for
 * {@linkcode PROBE_SELECTION_CACHE_TTL_MS} to avoid per-request probing.
 *
 * @param entries Ordered candidate entries.
 * @param probeTimeoutMs TCP connect timeout per candidate in ms (0 disables probing).
 */
export async function selectProxyEntry(
	entries: readonly ParsedProxyEntry[],
	probeTimeoutMs: number
): Promise<ProxySelectionResult> {
	if (entries.length <= 1) {
		return { entry: entries[0], probeFailures: [] };
	}
	if (!probeTimeoutMs || probeTimeoutMs <= 0) {
		const direct = entries.find((e) => e.kind === "direct");
		return { entry: direct ?? entries[0], probeFailures: [] };
	}

	const cacheKey = entries.map(proxyEntryIdentity).join(" -> ");
	const cached = probeSelectionCache.get(cacheKey);
	if (cached && Date.now() - cached.at < PROBE_SELECTION_CACHE_TTL_MS) {
		const hit = entries.find((e) => proxyEntryIdentity(e) === cached.identity);
		if (hit) {
			return { entry: hit, probeFailures: [] };
		}
		probeSelectionCache.delete(cacheKey);
	}

	const probeFailures: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "direct") {
			probeSelectionCache.set(cacheKey, { identity: proxyEntryIdentity(entry), at: Date.now() });
			return { entry, probeFailures };
		}
		try {
			await probeProxyTcp(entry.proxy, probeTimeoutMs);
			probeSelectionCache.set(cacheKey, { identity: proxyEntryIdentity(entry), at: Date.now() });
			return { entry, probeFailures };
		} catch (err) {
			probeFailures.push(`${entry.label}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { entry: entries[0], probeFailures };
}

/**
 * Check proxy reachability with a plain TCP connect. Both HTTP CONNECT proxies
 * and SOCKS proxies accept TCP eagerly, so a successful connect is treated as
 * "alive" without performing an actual protocol handshake.
 * @param proxy Parsed proxy target.
 * @param timeoutMs Connect timeout in ms.
 */
export function probeProxyTcp(proxy: ParsedProxy, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const host = proxy.kind === "http" ? new URL(proxy.uri).hostname : proxy.host;
		const port = proxy.kind === "http" ? Number(new URL(proxy.uri).port || 80) : proxy.port;
		const socket = net.connect({ host, port });
		let settled = false;

		const fail = (err: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			reject(err);
		};

		const timer = setTimeout(() => {
			fail(new Error(`TCP connect to ${host}:${port} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const succeed = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			resolve();
		};

		socket.once("connect", succeed);
		socket.once("error", (err: Error) => fail(err instanceof Error ? err : new Error(String(err))));
	});
}
