import * as net from "net";
import * as tls from "tls";
import { logger } from "./logger";

export interface ModelFetchOptions {
	proxy?: string;
	timeoutMs?: number;
}

export type ParsedProxy = { kind: "http"; uri: string } | { kind: "socks5"; host: string; port: number };

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60_000;
const HTTP_CONNECT_MAX_HEADER_BYTES = 64 * 1024;

const dispatcherCache = new Map<string, typeof fetch>();

export function parseModelProxy(proxy: string | undefined): ParsedProxy | undefined {
	const raw = (proxy ?? "").trim();
	if (!raw) {
		return undefined;
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid model proxy URL: ${raw}`);
	}

	const protocol = url.protocol.toLowerCase();
	if (protocol === "http:" || protocol === "https:") {
		return { kind: "http", uri: url.toString() };
	}
	if (protocol === "socks5:" || protocol === "socks5h:" || protocol === "socks:") {
		const host = url.hostname;
		const port = url.port ? Number(url.port) : 1080;
		if (!host || !Number.isFinite(port) || port <= 0) {
			throw new Error(`Invalid SOCKS proxy URL: ${raw}`);
		}
		if (url.username || url.password) {
			throw new Error(`SOCKS proxy auth is not supported: ${raw}`);
		}
		return { kind: "socks5", host, port };
	}

	throw new Error(`Unsupported model proxy scheme '${protocol}' in ${raw}; use http:// or socks5://`);
}

export function createModelFetch(options: ModelFetchOptions = {}): typeof fetch {
	const parsedProxy = parseModelProxy(options.proxy);
	const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0;
	if (!parsedProxy && timeoutMs <= 0) {
		return fetch;
	}

	const cacheKey = `${parsedProxy?.kind ?? "direct"}:${parsedProxy?.kind === "http" ? parsedProxy.uri : parsedProxy?.kind === "socks5" ? `${parsedProxy.host}:${parsedProxy.port}` : ""}:${timeoutMs}`;
	const cached = dispatcherCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	let undici: {
		Agent: new (opts: Record<string, unknown>) => unknown;
		fetch: typeof fetch;
	};
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		undici = require("undici") as typeof undici;
	} catch (err) {
		throw new Error(
			`Model proxy/timeout requires the bundled undici client, but it failed to load: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}

	const dispatcher = new undici.Agent({
		headersTimeout: timeoutMs || 0,
		bodyTimeout: timeoutMs || 0,
		connect: createProtocolConnector(parsedProxy),
	});

	logger.info("request.fetch.undici", {
		proxyKind: parsedProxy?.kind ?? "direct",
		timeoutMs,
	});

	const modelFetch = ((url: unknown, init?: RequestInit) =>
		undici.fetch(url as never, { ...(init ?? {}), dispatcher } as never)) as unknown as typeof fetch;
	dispatcherCache.set(cacheKey, modelFetch);
	return modelFetch;
}

function createProtocolConnector(
	proxy?: ParsedProxy
): (opts: Record<string, unknown>, callback: (err: Error | null, socket?: net.Socket) => void) => void {
	return (opts, callback) => {
		const hostname = String(opts.hostname ?? opts.host ?? "").replace(/:\d+$/, "");
		const protocol = String(opts.protocol ?? "https:");
		const port = Number(opts.port) || (protocol === "http:" ? 80 : 443);
		if (!hostname) {
			callback(new Error("Connect is missing a destination hostname"));
			return;
		}

		const proxyHost = !proxy ? hostname : proxy.kind === "http" ? new URL(proxy.uri).hostname : proxy.host;
		const proxyPort = !proxy ? port : proxy.kind === "http" ? Number(new URL(proxy.uri).port || 80) : proxy.port;
		const socket = net.connect({ host: proxyHost, port: proxyPort });
		let settled = false;
		const fail = (err: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			callback(err);
		};

		const timer = setTimeout(() => {
			fail(new Error(`Connect to ${proxyHost}:${proxyPort} timed out`));
		}, DEFAULT_CONNECT_TIMEOUT_MS);

		const succeed = (ready: net.Socket) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			callback(null, ready);
		};

		socket.setNoDelay(true);
		socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
		socket.once("error", (err) => fail(err));
		socket.once("connect", () => {
			const handshake = !proxy
				? Promise.resolve()
				: proxy.kind === "http"
					? handshakeHttpConnect(socket, hostname, port)
					: handshakeSocks5(socket, hostname, port);
			void handshake
				.then(() => {
					if (protocol !== "https:") {
						succeed(socket);
						return;
					}
					const servername = String(opts.servername || hostname);
					upgradeToTls(socket, servername, (err, tlsSocket) => {
						if (err || !tlsSocket) {
							fail(err ?? new Error("TLS upgrade failed"));
							return;
						}
						succeed(tlsSocket);
					});
				})
				.catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
		});
	};
}

function upgradeToTls(
	httpSocket: net.Socket,
	servername: string,
	callback: (err: Error | null, socket?: tls.TLSSocket) => void
): void {
	const tlsSocket = tls.connect({
		socket: httpSocket,
		servername,
	});
	tlsSocket.setNoDelay(true);
	tlsSocket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
	const onError = (err: Error) => callback(err);
	tlsSocket.once("error", onError);
	tlsSocket.once("secureConnect", () => {
		tlsSocket.off("error", onError);
		logger.info("request.fetch.tls", {
			servername,
			alpn: tlsSocket.alpnProtocol ?? "",
		});
		callback(null, tlsSocket);
	});
}

async function handshakeHttpConnect(socket: net.Socket, hostname: string, port: number): Promise<void> {
	const target = `${hostname}:${port}`;
	socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
	const headerBuf = await readUntil(socket, Buffer.from("\r\n\r\n"), HTTP_CONNECT_MAX_HEADER_BYTES);
	const statusLine = headerBuf.toString("latin1").split("\r\n")[0] ?? "";
	const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/i.exec(statusLine);
	const status = match ? Number(match[1]) : 0;
	if (status !== 200) {
		throw new Error(`HTTP CONNECT failed (${status || statusLine}) for ${target}`);
	}
}

async function handshakeSocks5(socket: net.Socket, hostname: string, port: number): Promise<void> {
	socket.write(Buffer.from([0x05, 0x01, 0x00]));
	const greeting = await readExact(socket, 2);
	if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
		throw new Error(`SOCKS5 proxy rejected greeting (ver=${greeting[0]} method=${greeting[1]})`);
	}

	const hostBuf = Buffer.from(hostname, "utf8");
	if (hostBuf.length > 255) {
		throw new Error(`SOCKS5 hostname is too long: ${hostname}`);
	}
	const request = Buffer.alloc(7 + hostBuf.length);
	request[0] = 0x05;
	request[1] = 0x01;
	request[2] = 0x00;
	request[3] = 0x03;
	request[4] = hostBuf.length;
	hostBuf.copy(request, 5);
	request.writeUInt16BE(port, 5 + hostBuf.length);
	socket.write(request);

	const head = await readExact(socket, 4);
	if (head[0] !== 0x05 || head[1] !== 0x00) {
		throw new Error(`SOCKS5 CONNECT failed (rep=${head[1]}) for ${hostname}:${port}`);
	}
	const atyp = head[3];
	if (atyp === 0x01) {
		await readExact(socket, 4 + 2);
	} else if (atyp === 0x04) {
		await readExact(socket, 16 + 2);
	} else if (atyp === 0x03) {
		const lenBuf = await readExact(socket, 1);
		await readExact(socket, lenBuf[0] + 2);
	} else {
		throw new Error(`SOCKS5 CONNECT returned unknown ATYP ${atyp}`);
	}
}

function readExact(socket: net.Socket, size: number): Promise<Buffer> {
	return readUntilBytes(socket, (buf) => (buf.length >= size ? size : -1));
}

function readUntil(socket: net.Socket, delimiter: Buffer, maxBytes: number): Promise<Buffer> {
	return readUntilBytes(socket, (buf) => {
		if (buf.length > maxBytes) {
			throw new Error(`Proxy handshake exceeded ${maxBytes} bytes`);
		}
		const idx = buf.indexOf(delimiter);
		return idx >= 0 ? idx + delimiter.length : -1;
	});
}

function readUntilBytes(socket: net.Socket, resolveSize: (buf: Buffer) => number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			received = Buffer.concat(chunks);
			let size: number;
			try {
				size = resolveSize(received);
			} catch (err) {
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			if (size >= 0) {
				cleanup();
				const extra = received.subarray(size);
				if (extra.length > 0) {
					socket.unshift(extra);
				}
				resolve(received.subarray(0, size));
			}
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const onClose = () => {
			cleanup();
			reject(new Error("Proxy closed during handshake"));
		};
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
		};
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
	});
}
