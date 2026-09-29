import * as assert from "assert";
import * as http from "http";
import * as net from "net";
import { createModelFetch, parseModelProxy } from "../httpClient";

suite("httpClient", () => {
	test("parses HTTP and SOCKS proxies and rejects unknown schemes", () => {
		assert.deepStrictEqual(parseModelProxy(""), undefined);
		assert.deepStrictEqual(parseModelProxy(undefined), undefined);
		assert.deepStrictEqual(parseModelProxy("http://127.0.0.1:2082"), {
			kind: "http",
			uri: "http://127.0.0.1:2082/",
		});
		assert.deepStrictEqual(parseModelProxy("socks5://127.0.0.1:1082"), {
			kind: "socks5",
			host: "127.0.0.1",
			port: 1082,
		});
		assert.throws(() => parseModelProxy("ftp://127.0.0.1:1082"), /Unsupported model proxy scheme/);
	});

	test("uses global fetch when no proxy or timeout is configured", () => {
		assert.strictEqual(createModelFetch({}), fetch);
		assert.strictEqual(createModelFetch({ timeoutMs: 0 }), fetch);
	});

	test("reuses dispatcher per proxy/timeout combo", () => {
		const a = createModelFetch({ proxy: "http://127.0.0.1:2082", timeoutMs: 10_000 });
		const b = createModelFetch({ proxy: "http://127.0.0.1:2082", timeoutMs: 10_000 });
		assert.strictEqual(a, b);
	});

	test("proxies plain HTTP through an HTTP CONNECT proxy without H2", async () => {
		const origin = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("h1-ok");
		});
		await listen(origin);
		const originPort = addressPort(origin);

		const proxy = net.createServer((client) => {
			const chunks: Buffer[] = [];
			const onData = (chunk: Buffer) => {
				chunks.push(chunk);
				const buf = Buffer.concat(chunks);
				const headerEnd = buf.indexOf("\r\n\r\n");
				if (headerEnd < 0) {
					return;
				}
				client.off("data", onData);
				const head = buf.subarray(0, headerEnd).toString("latin1");
				const extra = buf.subarray(headerEnd + 4);
				const match = /^CONNECT\s+([^:\s]+):(\d+)/i.exec(head);
				if (!match) {
					client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
					return;
				}
				const upstream = net.connect({ host: match[1], port: Number(match[2]) }, () => {
					client.write("HTTP/1.1 200 Connection established\r\n\r\n");
					if (extra.length > 0) {
						upstream.write(extra);
					}
					client.pipe(upstream);
					upstream.pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			};
			client.on("data", onData);
		});
		await listen(proxy);
		const proxyPort = addressPort(proxy);

		try {
			const modelFetch = createModelFetch({
				proxy: `http://127.0.0.1:${proxyPort}`,
				timeoutMs: 10_000,
			});
			const response = await modelFetch(`http://127.0.0.1:${originPort}/ping`);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(await response.text(), "h1-ok");
		} finally {
			origin.close();
			proxy.close();
		}
	});
});

function listen(server: net.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
}

function addressPort(server: net.Server): number {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("server is missing a TCP port");
	}
	return address.port;
}
