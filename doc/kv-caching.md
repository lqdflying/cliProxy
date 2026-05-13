# KV Caching

KV is optional but strongly recommended. Without KV, vscodeProxy still forwards requests, but it loses reasoning reuse, Azure response ID chaining, Claude thinking reuse, and image-description caching.

## Backends

| Runtime | Backend |
|---|---|
| Docker | Redis through `REDIS_URL` |
| Vercel | Upstash Redis REST through `KV_URL` and `KV_TOKEN` |
| EdgeOne Pages | Native KV binding through `EDGEONE_KV_BINDING` |

EdgeOne defaults to `vscodeproxy_kv` and still auto-detects legacy `cursorproxy_kv`.

## Cache Types

| Prefix | Purpose |
|---|---|
| `conv:` | Reasoning bridge state for DeepSeek, Kimi, and MiniMax |
| `azresp:` | Azure OpenAI response IDs for Chat Completions-to-Responses chaining |
| `asst:` | Normalized assistant-turn hashes for Claude thinking |
| `claude_thinking:` | Azure Anthropic thinking blocks |
| `img:` | Vision description cache |

## TTL

Default TTL is 7200 seconds. Override with:

```env
KV_TTL_SECONDS=7200
```

## Auth and Scope

When proxy auth is configured, cache scope includes a hash of the client-presented key. This prevents different API-key users from sharing reasoning and response IDs.

Accepted auth env vars:

- `VSCODEPROXY_API_KEY`
- legacy `CURSORPROXY_API_KEY`

## Azure OpenAI State

For Chat Completions mode, vscodeProxy stores Azure response IDs and uses `previous_response_id` when it can safely trim older input. This is internal to the Chat Completions adapter.

For public Responses mode, client-visible Responses semantics are preserved. Requests default to `store: true` unless the client explicitly sends `store: false`.
