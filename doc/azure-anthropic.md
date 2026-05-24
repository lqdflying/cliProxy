# Azure Anthropic

Azure Anthropic backs `claude-*` models through Anthropic Messages while exposing an OpenAI-compatible Chat Completions surface to clients.

## Public Surface

Chat Completions clients use:

```http
POST /v1/chat/completions
```

with a model such as:

```json
{ "model": "claude-sonnet-4-6" }
```

Accepted model forms:

- `claude-sonnet-4-6`
- `cliproxy/claude-sonnet-4-6`

## Translation

cliProxy converts:

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

Azure Anthropic also works through public `/v1/responses`. cliProxy converts Responses input to Anthropic Messages upstream and maps the Anthropic reply back to Responses output.

Function and custom Responses tools are converted to Anthropic tool definitions. Built-in Responses tools without an Anthropic equivalent are skipped, and malformed historical tool-call turns are repaired before forwarding upstream.
