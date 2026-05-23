# Reasoning Bridge

Some upstream providers return reasoning metadata that should be preserved for continuity but hidden from OpenAI-compatible clients.

cliProxy handles this by caching provider reasoning fields in KV and injecting them into later turns for the same conversation scope.

## Providers

| Provider | Reasoning field |
|---|---|
| DeepSeek | `reasoning_content` |
| Kimi | `reasoning_content` |
| MiniMax | `reasoning_details` |
| Azure Anthropic | thinking content blocks |
| Azure OpenAI | response IDs for `previous_response_id` chaining |

## Client Behavior

Chat Completions clients receive normal OpenAI-compatible messages. Provider-specific reasoning fields are stripped before responses are returned.

Responses clients on `/v1/responses` receive Responses-shaped output. Azure OpenAI uses native upstream Responses; Chat-only providers use cliProxy's Responses-to-Chat bridge and still hide provider-specific reasoning fields.

## Cache Scope

Cache keys include:

- provider
- configured proxy auth scope
- normalized conversation hash
- Azure deployment/resource where relevant

When `CLIPROXY_API_KEY` is set, cache scope is isolated by the presented client key. Without auth, clients share anonymous cache scope.

## Failure Behavior

KV cache misses are safe. The proxy falls back to stateless forwarding and the upstream model still answers normally, just without reused reasoning context.
