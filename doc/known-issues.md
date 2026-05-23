# Known Issues

## Responses Bridge Tool Coverage

`/v1/responses` is native for Azure OpenAI. For DeepSeek, Kimi, MiniMax, and Azure Anthropic, cliProxy bridges Responses requests through Chat-style upstream calls.

Only Responses tool definitions that can be represented safely as Chat Completions function tools are converted. Unsupported tool types return `400 unsupported_tool_type`.

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
