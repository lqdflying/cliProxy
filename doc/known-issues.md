# Known Issues

## `/v1/responses` Provider Coverage

Public `/v1/responses` is currently backed by Azure OpenAI only. Requests routed to DeepSeek, Kimi, MiniMax, or Azure Anthropic receive `responses_provider_unsupported`.

Use `/v1/chat/completions` for those providers.

## Model Discovery Size

Each configured model is advertised two ways: bare and `vscodeproxy/`. Clients with small model pickers may show a longer list. Use manual model entry if the picker becomes noisy.

## KV Disabled

The proxy works without KV, but these optimizations are disabled:

- provider reasoning reuse
- Azure Chat Completions response ID chaining
- Claude thinking reuse
- image-description caching

Set Redis, Upstash, or EdgeOne KV for production.
