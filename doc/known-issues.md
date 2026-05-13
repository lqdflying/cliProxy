# Known Issues

## `/v1/responses` Provider Coverage

Public `/v1/responses` is currently backed by Azure OpenAI only. Requests routed to DeepSeek, Kimi, MiniMax, or Azure Anthropic receive `responses_provider_unsupported`.

Use `/v1/chat/completions` for those providers.

## Docker Image Rename

The compose file and docs use `lqdflying/vscodeproxy:latest`. Existing deployments that still publish only `lqdflying/cursorproxy:latest` can keep using the old image name while the runtime remains backward compatible with `CURSORPROXY_*` and `cursorproxy/` IDs.

## Legacy Cursor Compatibility Notes

vscodeProxy is now centered on VS Code OAI-compatible plugins and Codex CLI. Legacy Cursor users can still use `cursorproxy/<model>` model IDs and `CURSORPROXY_*` env vars.

Known Cursor-side behaviors may still apply:

- Some Cursor builds route direct GPT/o-series model names through hardcoded OpenAI BYOK validation instead of the custom base URL.
- Some Cursor builds choose tools based on the visible model name before the proxy receives the request.
- Alias names such as `cursorproxy/gpt-general` may avoid routing bugs but can affect Cursor tool selection.

These are client behaviors outside the proxy. For general VS Code OAI plugins, prefer bare model IDs or `vscodeproxy/<model>`.

## Model Discovery Size

Each configured model is advertised three ways: bare, `vscodeproxy/`, and legacy `cursorproxy/`. Clients with small model pickers may show a longer list. Use manual model entry if the picker becomes noisy.

## KV Disabled

The proxy works without KV, but these optimizations are disabled:

- provider reasoning reuse
- Azure Chat Completions response ID chaining
- Claude thinking reuse
- image-description caching

Set Redis, Upstash, or EdgeOne KV for production.
