# Auth and Deployment

## Client Auth

Set `VSCODEPROXY_API_KEY` to require clients to authenticate with either:

```http
Authorization: Bearer <key>
```

or:

```http
x-api-key: <key>
```

Legacy `CURSORPROXY_API_KEY` is still accepted when `VSCODEPROXY_API_KEY` is unset. If neither variable is set, requests are anonymous and cache scope is shared.

## Model Discovery

Set models with:

```env
VSCODEPROXY_MODELS=gpt-5.5,gpt-general,claude-sonnet-4-6,deepseek-reasoner
```

Legacy fallback:

```env
CURSORPROXY_MODELS=...
```

`GET /v1/models` returns each model as bare, `vscodeproxy/<model>`, and legacy `cursorproxy/<model>` so VS Code plugins, Codex CLI, and existing clients can all select a working ID.

## Docker

```bash
docker run -d --pull always \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  lqdflying/vscodeproxy:latest
```

Docker Compose uses the `vscodeproxy` service and a local Redis service for KV caching:

```bash
docker compose up -d
```

## Vercel

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

Bind KV as `vscodeproxy_kv` or set:

```env
EDGEONE_KV_BINDING=<binding-name>
```

Existing `cursorproxy_kv` bindings are still auto-detected.

## Client URLs

Use this base URL for both supported client families:

```text
https://<host>/v1
```

VS Code OAI plugins should use Chat Completions. Codex CLI should use Responses mode with `wire_api = "responses"`.
