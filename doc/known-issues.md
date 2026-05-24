# Known Issues

## Responses Bridge Tool Coverage

`/v1/responses` is native for Azure OpenAI. For DeepSeek, Kimi, MiniMax, and Azure Anthropic, cliProxy bridges Responses requests through Chat-style upstream calls.

Only Responses tool definitions that can be represented safely as Chat Completions function tools are converted. Built-in Responses tool definitions without a Chat Completions equivalent are skipped, and malformed historical tool-call turns are repaired before forwarding to Chat-only upstreams.

Tool execution depends on the client, not the proxy. Chat Completions clients integrate most naturally with Chat-only models because both sides use `tool_calls` plus `role:"tool"` results. Responses API clients, such as Codex, may send richer tool and state items; cliProxy can translate only the overlapping subset. MCP, shell, web, approval, and other built-in tools must be executed by the client and returned as tool results. If the client reports an unsupported tool call, cliProxy cannot execute it on the provider's behalf.

## Model Discovery Size

Each configured model is advertised two ways: bare and `cliproxy/`. Clients with small model pickers may show a longer list. Use manual model entry if the picker becomes noisy.

## KV Disabled

The proxy works without KV, but these optimizations are disabled:

- provider reasoning reuse
- Azure Chat Completions response ID chaining
- Responses-to-Chat `previous_response_id` chaining
- Claude thinking reuse
- image-description caching

Set Redis, Upstash, or EdgeOne KV for production.
