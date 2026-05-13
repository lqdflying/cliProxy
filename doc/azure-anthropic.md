# Azure Anthropic

Azure Anthropic backs `claude-*` models through Anthropic Messages while exposing an OpenAI-compatible Chat Completions surface to clients.

## Public Surface

Use:

```http
POST /v1/chat/completions
```

with a model such as:

```json
{ "model": "claude-sonnet-4-6" }
```

Accepted model forms:

- `claude-sonnet-4-6`
- `vscodeproxy/claude-sonnet-4-6`

## Translation

vscodeProxy converts:

| Client shape | Anthropic shape |
|---|---|
| `messages` | `messages` |
| system/developer instructions | top-level system/instructions equivalent |
| OpenAI function/tool calls | Anthropic `tool_use` |
| `role: "tool"` results | Anthropic `tool_result` |
| SSE `content_block_delta` | OpenAI Chat Completions `choices[0].delta` |

## Thinking Cache

When `AZURE_ANTHROPIC_THINKING=adaptive`, thinking blocks are cached in KV and re-injected on later turns. Thinking deltas and signatures are not forwarded to Chat Completions clients; clients receive normal text/tool deltas.

Key variables:

| Variable | Description |
|---|---|
| `AZURE_FOUNDRY_API_KEY` | Sent as `x-api-key` |
| `AZURE_FOUNDRY_RESOURCE` | Used to build the default endpoint |
| `AZURE_ANTHROPIC_ENDPOINT` | Full endpoint override |
| `AZURE_ANTHROPIC_THINKING` | `adaptive` or `disabled` |
| `AZURE_ANTHROPIC_EFFORT` | `low`, `medium`, `high`, or `max` |

## Responses Endpoint

Azure Anthropic is not exposed through public `/v1/responses`. Use `/v1/chat/completions` for Claude models.
