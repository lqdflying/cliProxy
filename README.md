# cliProxy - OpenAI-Compatible CLI Model Proxy

cliProxy is a lightweight OpenAI-compatible model proxy for Codex CLI, Copilot CLI, and other command-line clients that can point at a custom `/v1` API base URL.

It exposes one public base URL and two standard API surfaces:

- **Codex CLI:** `POST /v1/responses`
- **Copilot CLI / Chat clients:** `POST /v1/chat/completions`
- **Model discovery:** `GET /v1/models`

Internally, cliProxy routes model names to DeepSeek, Kimi, MiniMax, Azure OpenAI, and Azure Anthropic. When a client uses `/v1/responses` with a Chat-only provider, cliProxy converts the request to Chat Completions upstream and maps the reply back to Responses JSON or SSE.

---

## Quick Start

### 1. Configure Secrets

Generate a proxy key:

```bash
openssl rand -hex 32
```

Set it as `CLIPROXY_API_KEY`.

Provider keys:

| Provider | Variables |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| Kimi | `KIMI_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| Azure OpenAI / Azure Anthropic | `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_RESOURCE` |

### 2. Configure Models

```env
CLIPROXY_MODELS=gpt-5.5,gpt-general,claude-sonnet-4-6,deepseek-v4-pro,kimi-k2.6,MiniMax-M2.7
```

`GET /v1/models` returns each configured model as:

- bare: `gpt-5.5`
- prefixed: `cliproxy/gpt-5.5`

Incoming requests may use bare IDs, `cliproxy/<model>`, legacy `vscodeproxy/<model>`, or legacy `azure/<model>`.

### 3. Run

Local Node:

```bash
npm install
npm start
```

Docker:

```bash
docker build -t cliproxy:latest .
docker run -d -p 127.0.0.1:3000:3000 --env-file .env cliproxy:latest
```

Docker Compose:

```bash
docker compose up -d --build
```

Vercel uses the checked-in rewrites. EdgeOne Pages must use the checked-in Cloud Functions under `cloud-functions/`; Pages Log Analysis does not currently show Edge Functions logs. On Vercel, set **Framework Preset** to **Other** so `server.js` stays Docker/local-only. The public base URL is always:

```text
https://<your-host>/v1
```

### 4. KV Storage

KV is recommended for reasoning reuse, Azure response chaining, Claude thinking reuse, image-description caching, and `previous_response_id` support for Responses-to-Chat bridging.

| Runtime | Variables |
|---|---|
| Docker | `REDIS_URL=redis://redis:6379` |
| Vercel | `KV_URL`, `KV_TOKEN` |
| EdgeOne Pages | bind KV as `cliproxy_kv`, or set `EDGEONE_KV_BINDING` |

---

## Client Setup

### Codex CLI

Use Responses mode:

```toml
# ~/.codex/config.toml
model_provider = "cliProxy"
model = "gpt-5.5"

[model_providers.cliProxy]
name = "cliProxy"
base_url = "https://<your-host>/v1"
env_key = "CLIPROXY_API_KEY"
wire_api = "responses"
```

### Copilot CLI / Chat Completions Clients

Use Chat Completions mode:

| Field | Value |
|---|---|
| Base URL | `https://<your-host>/v1` |
| API key | `CLIPROXY_API_KEY` |
| Endpoint | `/chat/completions` |
| Models | Pick from `GET /v1/models` |

---

## Essential Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CLIPROXY_API_KEY` | Recommended | Client auth secret |
| `CLIPROXY_MODELS` | Optional | Comma/newline-separated model IDs exposed through `/v1/models` |
| `DEEPSEEK_API_KEY` | For DeepSeek | Upstream API key |
| `DEEPSEEK_REASONING_EFFORT` | Optional | `high` default, or `max` |
| `KIMI_API_KEY` | For Kimi | Moonshot or Azure Foundry Kimi key |
| `UPSTREAM_KIMI` | Optional | Defaults to `https://api.moonshot.ai`; for Azure Foundry Kimi use `https://<resource>.services.ai.azure.com/openai` |
| `MINIMAX_API_KEY` | For MiniMax | Upstream key, also used by the default vision backend |
| `AZURE_FOUNDRY_API_KEY` | For Azure | Used as `api-key` for OpenAI and `x-api-key` for Anthropic |
| `AZURE_FOUNDRY_RESOURCE` | For Azure | Azure resource name |
| `AZURE_OPENAI_API_VERSION` | Optional | Default `2025-04-01-preview` |
| `AZURE_OPENAI_ENDPOINT` | Optional | Override Azure OpenAI endpoint |
| `AZURE_ANTHROPIC_ENDPOINT` | Optional | Override Azure Anthropic endpoint |
| `AZURE_OPENAI_REASONING_EFFORT` | Optional | Force Azure OpenAI reasoning effort |
| `AZURE_OPENAI_GENERAL_ALIAS_TARGET` | Optional | Real deployment for public alias `gpt-general` |
| `AZURE_OPENAI_GENERAL_REASONING_EFFORT` | Optional | Alias-only reasoning effort override |
| `AZURE_ANTHROPIC_THINKING` | Optional | `adaptive` or `disabled` |
| `AZURE_ANTHROPIC_EFFORT` | Optional | `low`, `medium`, `high`, or `max` |
| `KV_URL` / `KV_TOKEN` | Vercel KV | Upstash Redis REST credentials |
| `REDIS_URL` | Docker KV | Redis connection string |
| `EDGEONE_KV_BINDING` | EdgeOne KV | Binding name; default `cliproxy_kv` |
| `VISION_ALLOW_REMOTE_URLS` | Optional | Default `false`; only enable if clients send remote image URLs and you accept the SSRF caveats in `doc/vision-bridge.md` |
| `TRUST_PROXY` | Optional | Default `false`; only enable behind a reverse proxy you control |
| `MAX_BODY_BYTES` | Optional | Request body size cap; default `26214400` |

Legacy `VSCODEPROXY_API_KEY` and `VSCODEPROXY_MODELS` are accepted for migration, but new deployments should use `CLIPROXY_*`.

---

## Provider Notes

### Responses Bridge

`/v1/responses` is native for Azure OpenAI. For DeepSeek, Kimi, MiniMax, and Azure Anthropic, cliProxy converts Responses input to an upstream Chat-style request and maps the provider result back to Responses output.

If a Responses request uses a tool type that cannot be safely represented as Chat Completions, cliProxy returns `400 unsupported_tool_type`.

### Azure Foundry Kimi

Azure Foundry's Kimi OpenAI-compatible base is documented with `/openai/v1/`. Configure cliProxy without the final `/v1` because the proxy appends `/v1/<path>`:

```env
UPSTREAM_KIMI=https://<resource>.services.ai.azure.com/openai
KIMI_API_KEY=<your-azure-foundry-key>
CLIPROXY_MODELS=kimi-k2.6
```

### `gpt-general` Alias

`gpt-general` routes to the deployment configured by `AZURE_OPENAI_GENERAL_ALIAS_TARGET`. The response model stays client-facing:

- request `gpt-general` -> response `gpt-general`
- request `cliproxy/gpt-general` -> response `cliproxy/gpt-general`

---

## Docs

- [Architecture](doc/architecture-overview.md)
- [Auth and Deployment](doc/auth-and-deployment.md)
- [Azure OpenAI](doc/azure-openai.md)
- [Azure Anthropic](doc/azure-anthropic.md)
- [DeepSeek, Kimi, MiniMax](doc/deepseek-kimi-minimax.md)
- [Reasoning Bridge](doc/reasoning-bridge.md)
- [KV Caching](doc/kv-caching.md)
- [Vision Bridge](doc/vision-bridge.md)
- [Known Issues](doc/known-issues.md)

## License

MIT
