# Auth and Deployment

## Client Auth

Set `CLIPROXY_API_KEY` to require clients to authenticate with either:

```http
Authorization: Bearer <key>
```

or:

```http
x-api-key: <key>
```

If `CLIPROXY_API_KEY` is unset, requests are anonymous and cache scope is shared.

## Model Discovery

Set models with:

```env
CLIPROXY_MODELS=gpt-5.5,gpt-general,claude-sonnet-4-6,deepseek-reasoner
```

`GET /v1/models` returns each model as bare and `cliproxy/<model>` so Codex CLI, Copilot CLI, and other CLI clients can select a working ID.

## Docker

```bash
docker build -t cliproxy:latest .
docker run -d \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  cliproxy:latest
```

Docker Compose uses the `cliproxy` service and a local Redis service for KV caching:

```bash
docker compose up -d --build
```

## Vercel

Set the Vercel **Framework Preset** to **Other**. `server.js` is only for Docker/local Node; Vercel should route through `api/proxy.js`.

`vercel.json` rewrites these routes to `api/proxy.js`:

| Public route | Internal route |
|---|---|
| `/v1/:path*` | `/api/proxy?path=:path*` |
| `/v0/:path*` | `/api/proxy?path=:path*` |
| `/azure-openai/v1/:path*` | `/api/proxy?provider=azureopenai&path=:path*` |
| `/azure-anthropic/v1/:path*` | `/api/proxy?provider=azureanthropic&path=:path*` |
| `/deepseek/v1/:path*` | `/api/proxy?provider=deepseek&path=:path*` |
| `/kimi/v1/:path*` | `/api/proxy?provider=kimi&path=:path*` |
| `/minimax/v1/:path*` | `/api/proxy?provider=minimax&path=:path*` |

Use Upstash Redis REST for KV:

```env
KV_URL=...
KV_TOKEN=...
```

## EdgeOne Pages

Cloud Functions under `cloud-functions/` provide the same route behavior as Vercel while keeping logs visible in EdgeOne Log Analysis.

Bind KV as `cliproxy_kv` or set:

```env
EDGEONE_KV_BINDING=<binding-name>
```

## Client URLs

Use this base URL for both supported client families:

```text
https://<host>/v1
```

Copilot CLI and other Chat Completions clients should call `/v1/chat/completions`. Codex CLI should use Responses mode with `wire_api = "responses"`.

Legacy `VSCODEPROXY_API_KEY`, `VSCODEPROXY_MODELS`, and `vscodeproxy/<model>` inputs are still accepted for migration. New deployments should use `CLIPROXY_*` and `cliproxy/<model>`.
