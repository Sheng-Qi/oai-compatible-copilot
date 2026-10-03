import * as assert from "assert";
import { createServer } from "http";
import * as net from "net";
import {
	DIRECT_PROXY_KEYWORD,
	matchesProxyEnvironment,
	normalizeProxyProfiles,
	parseProxyProfilesJson,
	resolveAutoProxyEntries,
	resolveProxyEntries,
	resolveProxyForModel,
	splitProxySpec,
	selectProxyEntry,
	type ParsedProxyEntry,
	type ProxyProfile,
} from "../proxyConfig";

suite("proxyConfig", () => {
	suite("normalizeProxyProfiles", () => {
		test("keeps valid profiles and validates fields", () => {
			const { profiles, warnings } = normalizeProxyProfiles([
				{ name: "a", url: "http://127.0.0.1:2082" },
				{ name: "b", url: "", useIn: ["local"] },
				{ name: "c", url: "socks5://127.0.0.1:1082", useIn: ["remote", "wsl"] },
				null,
				42,
				{ url: "http://no-name" },
				{ name: "no-url" },
			]);
			assert.deepStrictEqual(profiles, [
				{ name: "a", url: "http://127.0.0.1:2082" },
				{ name: "b", url: "", useIn: ["local"] },
				{ name: "c", url: "socks5://127.0.0.1:1082", useIn: ["remote", "wsl"] },
			]);
			assert.ok(warnings.length >= 4, JSON.stringify(warnings));
		});

		test("drops duplicate names keeping the first", () => {
			const { profiles, warnings } = normalizeProxyProfiles([
				{ name: "dup", url: "http://first:1" },
				{ name: "dup", url: "http://second:2" },
			]);
			assert.deepStrictEqual(profiles, [{ name: "dup", url: "http://first:1" }]);
			assert.ok(warnings.length === 1);
		});

		test("handles non-array input", () => {
			const { profiles, warnings } = normalizeProxyProfiles("nope");
			assert.deepStrictEqual(profiles, []);
			assert.ok(warnings.length === 1);
		});
	});

	suite("matchesProxyEnvironment", () => {
		test("no filter matches everywhere", () => {
			assert.strictEqual(matchesProxyEnvironment(undefined, undefined), true);
			assert.strictEqual(matchesProxyEnvironment(undefined, "ssh-remote"), true);
			assert.strictEqual(matchesProxyEnvironment([], "ssh-remote"), true);
		});

		test("local matches only non-remote windows", () => {
			assert.strictEqual(matchesProxyEnvironment(["local"], undefined), true);
			assert.strictEqual(matchesProxyEnvironment(["local"], "ssh-remote"), false);
		});

		test("remote matches any remote window", () => {
			assert.strictEqual(matchesProxyEnvironment(["remote"], "ssh-remote"), true);
			assert.strictEqual(matchesProxyEnvironment(["remote"], "wsl"), true);
			assert.strictEqual(matchesProxyEnvironment(["remote"], undefined), false);
		});

		test("prefix matching of remoteName", () => {
			assert.strictEqual(matchesProxyEnvironment(["ssh"], "ssh-remote"), true);
			assert.strictEqual(matchesProxyEnvironment(["wsl"], "ssh-remote"), false);
			assert.strictEqual(matchesProxyEnvironment(["ssh", "local"], undefined), true);
		});
	});

	suite("splitProxySpec", () => {
		test("splits on separators and trims empties", () => {
			assert.deepStrictEqual(splitProxySpec("a, http://x:1 ; b|c"), ["a", "http://x:1", "b", "c"]);
			assert.deepStrictEqual(splitProxySpec("   "), []);
			assert.deepStrictEqual(splitProxySpec(""), []);
		});
	});

	suite("resolveProxyEntries", () => {
		const profiles: ProxyProfile[] = [
			{ name: "l", url: "http://127.0.0.1:2082", useIn: ["local"] },
			{ name: "r", url: "socks5://127.0.0.1:1082", useIn: ["remote"] },
			{ name: "any", url: "socks5://127.0.0.1:1083" },
		];

		test("keyword direct", () => {
			const res = resolveProxyEntries("DIRECT", profiles, undefined);
			assert.strictEqual(res.entries.length, 1);
			assert.strictEqual(res.entries[0].kind, "direct");
			assert.strictEqual(res.warnings.length, 0);
		});

		test("profile by name is resolved to its url", () => {
			const res = resolveProxyEntries("any", profiles, "ssh-remote");
			assert.strictEqual(res.entries.length, 1);
			assert.strictEqual(res.entries[0].kind, "proxy");
			assert.strictEqual(res.entries[0].kind === "proxy" ? res.entries[0].raw : "", "socks5://127.0.0.1:1083");
		});

		test("environment-filtered profiles are dropped with a warning", () => {
			const res = resolveProxyEntries("l", profiles, "ssh-remote");
			assert.strictEqual(res.entries.length, 0);
			assert.ok(res.warnings[0].includes("available in this environment"));
		});

		test("raw URLs pass through", () => {
			const res = resolveProxyEntries("http://127.0.0.1:9999", profiles, undefined);
			assert.strictEqual(res.entries.length, 1);
			assert.strictEqual(res.entries[0].kind, "proxy");
		});

		test("unknown names fall back to URL parsing and produce warnings", () => {
			const res = resolveProxyEntries("not_a_url_or_profile", profiles, undefined);
			assert.strictEqual(res.entries.length, 0);
			assert.ok(res.warnings.length === 1);
		});

		test("list keeps order and mixes kinds", () => {
			const res = resolveProxyEntries("r, http://127.0.0.1:9999, direct, any", profiles, "ssh-remote");
			const kinds = res.entries.map((e) => e.kind);
			assert.deepStrictEqual(kinds, ["proxy", "proxy", "direct", "proxy"]);
			assert.ok(res.warnings.length === 0);
		});

		test("empty spec returns no entries", () => {
			assert.deepStrictEqual(resolveProxyEntries("", profiles, undefined).entries, []);
			assert.deepStrictEqual(resolveProxyEntries(undefined, profiles, undefined).entries, []);
		});

		test("DIRECT_PROXY_KEYWORD is not case sensitive and 'none' works too", () => {
			assert.strictEqual(resolveProxyEntries("none", profiles, undefined).entries[0].kind, "direct");
			assert.strictEqual(DIRECT_PROXY_KEYWORD, "direct");
		});
	});

	suite("resolveAutoProxyEntries", () => {
		const profiles: ProxyProfile[] = [
			{ name: "l", url: "http://127.0.0.1:2082", useIn: ["local"] },
			{ name: "r", url: "socks5://127.0.0.1:1082", useIn: ["remote"] },
			{ name: "d", url: "" },
		];

		test("picks the first local-matching profile", () => {
			const res = resolveAutoProxyEntries(profiles, undefined);
			assert.strictEqual(res.entries.length, 1);
			assert.strictEqual(res.entries[0].label, "l");
		});

		test("picks the first remote-matching profile", () => {
			const res = resolveAutoProxyEntries(profiles, "ssh-remote");
			assert.strictEqual(res.entries[0].label, "r");
		});

		test("profiles resolving to direct counts as a hit", () => {
			const res = resolveAutoProxyEntries([{ name: "d", url: "" }], "ssh-remote");
			assert.strictEqual(res.entries[0].kind, "direct");
		});
	});

	suite("resolveProxyForModel", () => {
		const profiles: ProxyProfile[] = [{ name: "r", url: "socks5://127.0.0.1:1082", useIn: ["remote"] }];

		test("model spec wins", () => {
			const res = resolveProxyForModel("http://model:1", "http://global:2", profiles, "ssh-remote");
			assert.strictEqual(res.entries[0].kind === "proxy" ? res.entries[0].raw : "", "http://model:1");
		});

		test("falls back to global spec when model spec empty", () => {
			const res = resolveProxyForModel("", "http://global:2", profiles, "ssh-remote");
			assert.strictEqual(res.entries[0].kind === "proxy" ? res.entries[0].raw : "", "http://global:2");
		});

		test("global spec filtered to nothing falls back to auto", () => {
			const res = resolveProxyForModel(
				"l",
				"l",
				[
					{ name: "l", url: "http://127.0.0.1:1", useIn: ["local"] },
					{ name: "r", url: "socks5://127.0.0.1:1082", useIn: ["remote"] },
				],
				"ssh-remote"
			);
			assert.strictEqual(res.entries[0].label, "r");
		});

		test("nothing configured means direct (empty entries)", () => {
			assert.deepStrictEqual(resolveProxyForModel("", "", [], "ssh-remote").entries, []);
			assert.deepStrictEqual(resolveProxyForModel(undefined, undefined, [], undefined).entries, []);
		});

		test("model spec keeps explicit direct even when profiles exist", () => {
			const res = resolveProxyForModel("direct", "r", profiles, "ssh-remote");
			assert.strictEqual(res.entries[0].kind, "direct");
		});
	});

	suite("parseProxyProfilesJson", () => {
		test("empty text yields empty list", () => {
			assert.deepStrictEqual(parseProxyProfilesJson(""), { ok: true, value: [] });
			assert.deepStrictEqual(parseProxyProfilesJson("   "), { ok: true, value: [] });
		});

		test("valid JSON profiles", () => {
			const res = parseProxyProfilesJson('[{"name":"a","url":"http://x:1"}]');
			assert.ok(res.ok);
			assert.deepStrictEqual(res.ok ? res.value : [], [{ name: "a", url: "http://x:1" }]);
		});

		test("invalid JSON reports error", () => {
			assert.strictEqual(parseProxyProfilesJson("{bad").ok, false);
		});
	});

	suite("selectProxyEntry", () => {
		const mkProxy = (raw: string): ParsedProxyEntry => {
			const res = resolveProxyEntries(raw, [], undefined);
			const first = res.entries[0];
			assert.ok(first);
			return first;
		};

		test("single candidate is returned without probing", async () => {
			const entry = mkProxy("http://127.0.0.1:1");
			const res = await selectProxyEntry([entry], 50);
			assert.strictEqual(res.entry, entry);
			assert.strictEqual(res.probeFailures.length, 0);
		});

		test("empty candidate list", async () => {
			const res = await selectProxyEntry([], 50);
			assert.strictEqual(res.entry, undefined);
		});

		test("probing disabled keeps order but direct beats proxies", async () => {
			const a = mkProxy("http://127.0.0.1:1");
			const d = mkProxy("direct");
			const res = await selectProxyEntry([a, d], 0);
			assert.strictEqual(res.entry, d);
		});

		test("probes in order and selects the first reachable candidate", async () => {
			const alive = createServer();
			await new Promise<void>((resolve) => alive.listen(0, "127.0.0.1", resolve));
			const port = (alive.address() as net.AddressInfo).port;

			// Find a (very likely) closed port on localhost for the dead candidate.
			const dead = net.createServer(() => {
				/* not listening */
			});
			await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
			const deadPort = (dead.address() as net.AddressInfo).port;
			await new Promise<void>((resolve) => dead.close(() => resolve()));

			const res = await selectProxyEntry(
				[mkProxy(`socks5://127.0.0.1:${deadPort}`), mkProxy(`http://127.0.0.1:${port}`), mkProxy("direct")],
				800
			);
			assert.ok(res.entry);
			assert.strictEqual(res.entry.kind, "proxy");
			assert.strictEqual(res.entry.kind === "proxy" ? res.entry.raw : "", `http://127.0.0.1:${port}`);
			assert.strictEqual(res.probeFailures.length, 1);

			// Cached selection avoids re-probing (the dead port could be reused by another process).
			const res2 = await selectProxyEntry(
				[mkProxy(`socks5://127.0.0.1:${deadPort}`), mkProxy(`http://127.0.0.1:${port}`), mkProxy("direct")],
				800
			);
			assert.strictEqual(res2.probeFailures.length, 0);

			alive.close();
		});

		test("all candidates unreachable falls back to the first", async () => {
			const dead = net.createServer(() => {
				/* not listening */
			});
			await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
			const deadPort = (dead.address() as net.AddressInfo).port;
			await new Promise<void>((resolve) => dead.close(() => resolve()));

			const res = await selectProxyEntry(
				[mkProxy(`socks5://127.0.0.1:${deadPort}`), mkProxy(`http://127.0.0.1:${deadPort}`)],
				300
			);
			assert.ok(res.entry);
			assert.strictEqual(res.probeFailures.length, 2);
		});
	});
});
