import http from "node:http";
import { pathToFileURL } from "node:url";
import handler from "./api/proxy.js";
import { setKvDriver } from "./api/kv.js";

const DEBUG = process.env.DEBUG === "true";

// ─── Local Redis (Docker) ──────────────────────────────────────────────────
// If REDIS_URL is set, use ioredis for low-latency local cache.
// Falls back to Upstash REST (KV_URL + KV_TOKEN) if not set.
if (process.env.REDIS_URL) {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, enableReadyCheck: false });
  redis.on("error", (err) => console.error("[cliProxy:server] redis error:", err.message));
  setKvDriver(redis);
  console.log("[cliProxy:server] using local Redis:", process.env.REDIS_URL);
}

const PORT = process.env.PORT || 3000;

// Only read x-forwarded-* headers when running behind a known reverse proxy.
// When the server is exposed directly (e.g. `docker run -p 3000:3000`) any
// client can forge these, which poisons logs and the upstream Request URL.
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

// Cap on the total request body size. Without a cap, a single client can
// stream an unbounded POST and exhaust the container's memory.
function maxBodyBytes() {
  const raw = parseInt(process.env.MAX_BODY_BYTES || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 25 * 1024 * 1024; // 25 MB default — large enough for image payloads
}

// Route table mirrors vercel.json rewrites (legacy paths set provider; unified /v1 uses model-based routing)
const ROUTES = [
  { pattern: /^\/deepseek\/v1\/(.+)$/, provider: "deepseek" },
  { pattern: /^\/kimi\/v1\/(.+)$/, provider: "kimi" },
  { pattern: /^\/minimax\/v1\/(.+)$/, provider: "minimax" },
  { pattern: /^\/azure-openai\/v1\/(.+)$/, provider: "azureopenai" },
  { pattern: /^\/azure-anthropic\/v1\/(.+)$/, provider: "azureanthropic" },
  { pattern: /^\/v1\/(.+)$/, provider: null },
  { pattern: /^\/v0\/(.+)$/, provider: null },
];

export function rewriteUrl(rawUrl, host, protocol) {
  const urlObj = new URL(rawUrl, `${protocol}://${host}`);
  for (const { pattern, provider } of ROUTES) {
    const m = urlObj.pathname.match(pattern);
    if (m) {
      urlObj.pathname = "/api/proxy";
      if (provider) urlObj.searchParams.set("provider", provider);
      urlObj.searchParams.set("path", m[1]);
      return urlObj.toString();
    }
  }
  return urlObj.toString();
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url === "/") {
      res.writeHead(302, { location: "https://github.com/lqdflying/cliProxy" });
      res.end();
      return;
    }

    const protocol = TRUST_PROXY
      ? (req.headers["x-forwarded-proto"]?.split(",")[0].trim() || "http")
      : "http";
    const host = TRUST_PROXY
      ? (req.headers["x-forwarded-host"] || req.headers["host"] || "localhost")
      : (req.headers["host"] || "localhost");

    const targetUrl = rewriteUrl(req.url, host, protocol);

    // Read body into a Buffer, refusing payloads larger than maxBodyBytes().
    // Fail fast on Content-Length when the client declares an oversized body.
    // Otherwise stream-count bytes and, on overflow, send 413 first; then
    // drain briefly so the response actually reaches the client, but bound
    // that drain so a slow/malicious chunked sender cannot pin the handler.
    const limit = maxBodyBytes();
    const drainMs = (() => {
      const raw = parseInt(process.env.OVERSIZE_DRAIN_MS || "", 10);
      return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
    })();
    const declaredLen = parseInt(req.headers["content-length"] || "", 10);
    const send413 = () => {
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(
          JSON.stringify({
            error: {
              message: `Request body exceeds ${limit} bytes`,
              type: "payload_too_large",
            },
          })
        );
      }
    };
    // After 413: let the kernel buffer absorb any in-flight bytes for a
    // short window, then forcibly destroy the socket so the handler can
    // return and a slow chunked client cannot keep us alive indefinitely.
    const drainAndClose = () => {
      req.resume();
      if (drainMs === 0) {
        req.destroy();
        return;
      }
      const t = setTimeout(() => req.destroy(), drainMs);
      t.unref();
      req.once("end", () => clearTimeout(t));
      req.once("close", () => clearTimeout(t));
    };
    if (Number.isFinite(declaredLen) && declaredLen > limit) {
      send413();
      drainAndClose();
      return;
    }

    const chunks = [];
    let received = 0;
    let oversized = false;
    for await (const chunk of req) {
      if (oversized) continue; // keep draining without buffering
      received += chunk.length;
      if (received > limit) {
        oversized = true;
        send413();
        drainAndClose();
        continue;
      }
      chunks.push(chunk);
    }
    if (oversized) return;
    const body = Buffer.concat(chunks);

    // Best-effort extract model for access log (parse failures are silent).
    // Gate behind DEBUG so large image payloads are not stringified on every request.
    let modelInfo = "";
    if (DEBUG) {
      try {
        const json = JSON.parse(body.toString());
        if (json.model) modelInfo += ` model=${json.model}`;
        modelInfo += ` stream=${json.stream ?? "-"}`;
      } catch {}
    }

    // Build Web API Headers (join any multi-value arrays)
    const headersInit = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headersInit[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    const webRequest = new Request(targetUrl, {
      method: req.method,
      headers: headersInit,
      body: body.length > 0 ? body : null,
    });

    const webResponse = await handler(webRequest);

    const outHeaders = {};
    webResponse.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(webResponse.status, outHeaders);

    if (DEBUG) console.log(`[cliProxy:server] ${req.method} ${req.url} -> ${webResponse.status} (${Date.now() - start}ms)${modelInfo}`);

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    }
    res.end();
  } catch (err) {
    console.error("[cliProxy:server] server error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Internal server error", type: "server_error" },
        })
      );
    }
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  server.listen(PORT, () => {
    console.log(`[cliProxy:server] listening on port ${PORT}`);
  });
}

// Graceful shutdown: stop accepting new connections, let in-flight requests
// (including SSE streams) drain, then exit. Force-exit after a hard deadline
// so a stuck stream can't block container shutdown forever.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS || "", 10);
  const deadline = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 25000;
  console.log(`[cliProxy:server] ${signal} received, draining (max ${deadline}ms)...`);
  server.close((err) => {
    if (err) console.error("[cliProxy:server] server.close error:", err.message);
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[cliProxy:server] grace period elapsed, forcing exit");
    process.exit(0);
  }, deadline).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
