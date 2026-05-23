# Architecture Overview

cliProxy exposes an OpenAI-compatible `/v1` surface for CLI client families:

- **Chat Completions clients:** Copilot CLI and OpenAI-compatible CLIs call `/v1/chat/completions`.
- **Responses clients:** Codex CLI calls `/v1/responses`.

The proxy resolves the requested model to a provider, normalizes the request only as much as that provider requires, and returns the same public API shape the client requested.

## Request Flow

```mermaid
flowchart TD
    C["CLI client\nCodex or Copilot CLI"]
    E["Entry point\nserver.js, Vercel, or EdgeOne"]
    A["Auth\nCLIPROXY_API_KEY"]
    M["Model discovery/routing\nbare or cliproxy/"]
    F["Format adapter"]
    K["KV cache\nreasoning, Azure response IDs,\nvision, Claude thinking"]
    U["Upstream provider"]

    C -->|"GET /v1/models"| E
    C -->|"POST /v1/chat/completions"| E
    C -->|"POST /v1/responses"| E
    E --> A --> M --> F --> U
    F <-->|read/write| K
    U --> F --> E --> C
```

## Provider Routing

| Model shape | Provider |
|---|---|
| `gpt-*`, `o*`, `gpt-general` | Azure OpenAI |
| `claude-*` | Azure Anthropic |
| `deepseek-*` | DeepSeek |
| `kimi-*` | Kimi |
| `minimax-*` | MiniMax |

Prefixes are stripped before routing:

- `cliproxy/gpt-5.5`
- `azure/gpt-5.5`

The response model follows the client request form when possible. For example, `cliproxy/gpt-general` remains `cliproxy/gpt-general` in the response.

## Public API Modes

| Public path | Primary client | Upstream behavior |
|---|---|---|
| `/v1/models` | All clients | Returns bare and `cliproxy/` IDs from `CLIPROXY_MODELS` |
| `/v1/chat/completions` | Copilot CLI / Chat clients | For Azure OpenAI, converts Chat Completions to Azure Responses and maps output back to Chat Completions |
| `/v1/responses` | Codex CLI | Uses native Azure OpenAI Responses, or converts to/from Chat for Chat-only providers |

Both public API modes are supported through Docker/local Node, Vercel, and EdgeOne because each runtime rewrites to the same shared handler.

## Runtime Entry Points

| Runtime | Entry |
|---|---|
| Docker / local Node | `server.js` |
| Vercel Edge | `api/proxy.js` via `vercel.json` rewrites |
| EdgeOne Pages | `cloud-functions/v1/[[default]].js` and provider-specific legacy routes |

## Key Modules

| File | Role |
|---|---|
| `api/proxy.js` | Main request handler, routing, auth, upstream fetch, streaming |
| `api/models.js` | Model prefix parsing, discovery, alias handling |
| `api/azure-openai.js` | Azure Responses normalization and Chat Completions mapping |
| `api/azure-anthropic.js` | Anthropic Messages mapping |
| `api/responses-bridge.js` | Responses-to-Chat bridge for Chat-only providers |
| `api/reasoning.js` | Reasoning cache injection/extraction |
| `api/vision-bridge.js` | Image-to-text bridge for text-only providers |
| `api/kv.js` | Redis, Upstash, and EdgeOne KV abstraction |
