import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer } from "node:net";

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** True when nothing listens on the port, on loopback or any interface. */
export async function isPortFree(port: number): Promise<boolean> {
  return (await canBind(port, "127.0.0.1")) && (await canBind(port, "0.0.0.0"));
}

/** First free port at or above `preferred` that is not in `taken`. */
export async function nextFreePort(preferred: number, taken: ReadonlySet<number>, isFree: (port: number) => Promise<boolean> = isPortFree): Promise<number> {
  for (let port = preferred; port < Math.min(preferred + 200, 65_536); port += 1) {
    if (!taken.has(port) && (await isFree(port))) return port;
  }
  throw new Error(`no free TCP port found between ${preferred} and ${preferred + 199}`);
}

export interface HttpProbe {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

/** GET a URL, trusting `ca` (PEM) for HTTPS. Never throws. */
export function probeHttp(url: string, options: { ca?: string | Buffer | Array<string | Buffer> | undefined; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<HttpProbe> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, body: "", error: "invalid URL" });
      return;
    }
    const timeoutMs = options.timeoutMs ?? 3000;
    const handler = (response: IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (body.length < 1_000_000) body += chunk; });
      response.on("end", () => resolve({ ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300, status: response.statusCode ?? 0, body }));
      response.on("error", (error) => resolve({ ok: false, status: response.statusCode ?? 0, body, error: error.message }));
    };
    const headers = options.headers ?? {};
    const request = target.protocol === "https:"
      ? httpsRequest(target, { method: "GET", headers, ...(options.ca ? { ca: options.ca } : {}), timeout: timeoutMs }, handler)
      : httpRequest(target, { method: "GET", headers, timeout: timeoutMs }, handler);
    request.on("timeout", () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, status: 0, body: "", error: describeNetworkError(error) }));
    request.end();
  });
}

export function describeNetworkError(error: NodeJS.ErrnoException): string {
  if (error.code === "ECONNREFUSED") return "connection refused (not running?)";
  if (error.code === "ENOTFOUND") return "host not found";
  if (error.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || error.code === "SELF_SIGNED_CERT_IN_CHAIN") return `certificate not trusted (${error.code})`;
  if (error.code === "ERR_TLS_CERT_ALTNAME_INVALID") return "certificate does not match the host name";
  if (error.code === "EPROTO" || /wrong version number/u.test(error.message)) return "TLS mismatch (HTTP vs HTTPS)";
  return error.message || error.code || "network error";
}

export type RedisProbe = "ok" | "auth-required" | "not-redis" | "down";

/** Sends PING over a plain TCP connection. */
export function probeRedis(host: string, port: number, timeoutMs = 2000): Promise<RedisProbe> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    let reply = "";
    const finish = (result: RedisProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(reply ? "not-redis" : "down"));
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data", (chunk) => {
      reply += chunk.toString("latin1");
      if (!reply.includes("\r\n")) return;
      if (reply.startsWith("+PONG")) finish("ok");
      else if (/^-(NOAUTH|WRONGPASS)/u.test(reply)) finish("auth-required");
      else finish("not-redis");
    });
    socket.on("error", () => finish("down"));
    socket.on("close", () => finish(reply ? "not-redis" : "down"));
  });
}

export type QdrantProbe = "ok" | "auth-required" | "not-qdrant" | "down";

export async function probeQdrant(url: string, timeoutMs = 3000): Promise<QdrantProbe> {
  const probe = await probeHttp(`${url.replace(/\/+$/u, "")}/collections`, { timeoutMs });
  if (probe.status === 401 || probe.status === 403) return "auth-required";
  if (probe.status === 0) return "down";
  try {
    const body = JSON.parse(probe.body) as { result?: { collections?: unknown } };
    return probe.ok && Array.isArray(body.result?.collections) ? "ok" : "not-qdrant";
  } catch {
    return "not-qdrant";
  }
}

/** host:port of a redis:// or http:// URL, with the scheme's default port. */
export function hostPort(url: string, defaultPort: number): { host: string; port: number } {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/gu, "") || "127.0.0.1";
  return { host: host === "localhost" ? "127.0.0.1" : host, port: parsed.port ? Number(parsed.port) : defaultPort };
}
