# DeepSeek, Kimi, and MiniMax

These providers are exposed through the Chat Completions-compatible path:

```http
POST /v1/chat/completions
```

They are intended for VS Code OAI/Copilot-compatible plugins and other OpenAI Chat Completions clients.

## Routing

| Model prefix | Provider |
|---|---|
| `deepseek-*` | DeepSeek |
| `kimi-*` | Kimi |
| `minimax-*` | MiniMax |

Client-facing prefixes are optional:

- `deepseek-reasoner`
- `vscodeproxy/deepseek-reasoner`

## Provider Notes

### DeepSeek

vscodeProxy injects DeepSeek thinking controls:

```env
DEEPSEEK_REASONING_EFFORT=high
```

Use `max` for the higher reasoning setting.

### Kimi

Default upstream:

```env
UPSTREAM_KIMI=https://api.moonshot.ai
```

For Azure Foundry Kimi:

```env
UPSTREAM_KIMI=https://<resource>.services.ai.azure.com/openai
KIMI_API_KEY=<azure-foundry-key>
```

Do not include the final `/v1` in `UPSTREAM_KIMI`; vscodeProxy appends `/v1/<path>`.

### MiniMax

MiniMax uses:

```env
MINIMAX_API_KEY=...
```

The same key is also used by the default vision bridge backend.

## Reasoning Bridge

DeepSeek, Kimi, and MiniMax expose reasoning fields that are useful on the next turn but should not be shown to Chat Completions clients. vscodeProxy strips those fields from responses, caches them in KV, and injects them into later requests for the same conversation scope.

## Vision Bridge

DeepSeek and MiniMax chat endpoints do not accept inline images natively. When a request contains image blocks, vscodeProxy calls the configured vision backend, replaces images with text descriptions, and forwards a text-only prompt upstream.

## Responses Endpoint

These providers are not exposed through public `/v1/responses`. Use Chat Completions mode.
