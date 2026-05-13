# vscodeProxy - OpenAI-Compatible Proxy for VS Code and Codex

vscodeProxy is a lightweight OpenAI-compatible proxy for VS Code AI extensions, Codex CLI, and other clients that can point at a custom `/v1` API base URL.

It routes model names to DeepSeek, Kimi, MiniMax, Azure OpenAI, and Azure Anthropic, while keeping client-facing OpenAI API shapes stable.

- **VS Code OAI/Copilot-compatible plugins:** use `/v1/chat/completions`, OpenAI-style JSON/SSE chunks, and `/v1/models`.
- **Codex CLI:** use `/v1/responses` with Responses-shaped JSON/SSE for Azure OpenAI-backed models.
- **Azure OpenAI bridge:** accepts Chat Completions from editor plugins, forwards to Azure Responses, and maps the result back when needed.
- **Reasoning cache:** stores provider reasoning artifacts for DeepSeek, Kimi, MiniMax, Azure OpenAI response IDs, and Azure Anthropic thinking blocks.
- **Vision bridge:** converts inline images to text for providers that do not accept native image input.
- **Model discovery:** reads `VSCODEPROXY_MODELS` and advertises bare model IDs plus `vscodeproxy/` aliases.

---

## Quick Start

### 1. Configure Secrets

Generate a proxy key:

```bash
openssl rand -hex 32
```

Set it as `VSCODEPROXY_API_KEY`.

Provider keys:

| Provider | Variables |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| Kimi | `KIMI_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| Azure OpenAI / Azure Anthropic | `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_RESOURCE` |

### 2. Configure Models

```env
VSCODEPROXY_MODELS=gpt-5.5,gpt-general,claude-sonnet-4-6,deepseek-reasoner,Kimi-K2.6,MiniMax-M2.7
```

`GET /v1/models` returns each configured model as:

- bare: `gpt-5.5`
- prefixed: `vscodeproxy/gpt-5.5`

Incoming requests may use any of those forms. The proxy forwards the bare deployment name upstream.

### 3. Deploy

Docker:

```bash
docker run -d --pull always -p 127.0.0.1:3000:3000 --env-file .env lqdflying/vscodeproxy:latest
```

Docker Compose:

```bash
# Create/edit .env with the variables below, then:
docker compose up -d
```

Vercel and EdgeOne use the checked-in rewrites/cloud functions. The unified public base URL is always:

```text
https://<your-host>/v1
```

### 4. KV Storage

KV is recommended for reasoning reuse, Azure response chaining, and vision caching.

| Runtime | Variables |
|---|---|
| Docker | `REDIS_URL=redis://redis:6379` |
| Vercel | `KV_URL`, `KV_TOKEN` |
| EdgeOne Pages | bind KV as `vscodeproxy_kv`, or set `EDGEONE_KV_BINDING` |

---

## Client Setup

### VS Code OAI / OpenAI-Compatible Plugins

Use Chat Completions mode:

| Field | Value |
|---|---|
| Base URL | `https://<your-host>/v1` |
| API key | `VSCODEPROXY_API_KEY` |
| Endpoint | `/chat/completions` |
| Models | Pick from `GET /v1/models` |

This is the compatibility path for OAIProvider, OAICopilot-style extensions, and any VS Code plugin that speaks OpenAI Chat Completions.

### Codex CLI

Use Responses mode for Azure OpenAI-backed GPT/o-series models:

```toml
# ~/.codex/config.toml
[model_providers.vscodeProxy]
name = "vscodeProxy"
base_url = "https://<your-host>/v1"
env_key = "VSCODEPROXY_API_KEY"
wire_api = "responses"

model_provider = "vscodeProxy"
model = "gpt-5.5"
```

`/v1/responses` is currently backed by the Azure OpenAI provider. Use `/v1/chat/completions` for DeepSeek, Kimi, MiniMax, and Azure Anthropic.

---

## Essential Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VSCODEPROXY_API_KEY` | Recommended | Client auth secret |
| `VSCODEPROXY_MODELS` | Optional | Comma/newline-separated model IDs exposed through `/v1/models` |
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
| `EDGEONE_KV_BINDING` | EdgeOne KV | Binding name; default `vscodeproxy_kv` |
| `VISION_ALLOW_REMOTE_URLS` | Optional | Default `false`. When unset/false, only `data:` image URIs are forwarded to the vision backend; `http(s)` image URLs in client messages are replaced with a placeholder. Set to `true` if your clients (e.g. some VS Code OAI plugins) send remote `https://…` image references. Even with this enabled, loopback / link-local / RFC1918 / ULA / multicast hosts are still rejected. |
| `TRUST_PROXY` | Optional | Default `false`. Set to `true` only when the Docker server is behind a reverse proxy you control, so `X-Forwarded-Proto` / `X-Forwarded-Host` are honored. When false, both headers are ignored to prevent header poisoning by direct clients. |
| `MAX_BODY_BYTES` | Optional | Cap on request body size in bytes (default `26214400` = 25 MB). Oversized requests return `413 payload_too_large`. |
| `OVERSIZE_DRAIN_MS` | Optional | After a `413`, how long (ms) to drain the client body before forcibly destroying the socket. Default `2000`. Set `0` to destroy immediately. |

---

## Azure Notes

### Azure Foundry Kimi

Azure Foundry's Kimi OpenAI-compatible base is documented with `/openai/v1/`. Configure vscodeProxy without the final `/v1` because the proxy appends `/v1/<path>`:

```env
UPSTREAM_KIMI=https://<resource>.services.ai.azure.com/openai
KIMI_API_KEY=<your-azure-foundry-key>
VSCODEPROXY_MODELS=Kimi-K2.6
```

### `gpt-general` Alias

`gpt-general` routes to the deployment configured by `AZURE_OPENAI_GENERAL_ALIAS_TARGET`. The response model stays client-facing:

- request `gpt-general` -> response `gpt-general`
- request `vscodeproxy/gpt-general` -> response `vscodeproxy/gpt-general`

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
