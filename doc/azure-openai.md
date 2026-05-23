# Azure OpenAI

Azure OpenAI is the primary backend for GPT/o-series models and the only provider that receives native upstream Responses API calls. Other providers can still be used through public `/v1/responses` via cliProxy's Responses-to-Chat bridge.

## Chat Completions Mode

Copilot CLI and other Chat Completions-compatible clients call:

```http
POST /v1/chat/completions
```

cliProxy:

1. Strips `cliproxy/` or `azure/` prefixes from `model`.
2. Converts Chat Completions `messages` to Responses `input`.
3. Normalizes tools for Azure Responses, including function tools and Codex-style `apply_patch`.
4. Calls Azure OpenAI `/openai/responses`.
5. Maps non-streaming and streaming Responses output back to Chat Completions JSON/SSE.

This keeps Chat Completions clients on a stable OpenAI wire shape while still using Azure's current Responses backend.

## Responses Mode

Codex CLI calls:

```http
POST /v1/responses
```

In this mode cliProxy preserves Responses JSON/SSE. It still performs auth, model prefix stripping, Azure endpoint construction, alias resolution, request sanitization, and model-name normalization, but it does not collapse output into Chat Completions chunks.

Recommended Codex config:

```toml
model_provider = "cliProxy"
model = "gpt-5.5"

[model_providers.cliProxy]
name = "cliProxy"
base_url = "https://<host>/v1"
env_key = "CLIPROXY_API_KEY"
wire_api = "responses"
```

## Aliases

`gpt-general` is a public alias for a real Azure deployment:

```env
AZURE_OPENAI_GENERAL_ALIAS_TARGET=gpt-5.5-mini
```

The response model mirrors the client-facing request:

| Request model | Upstream model | Response model |
|---|---|---|
| `gpt-general` | `gpt-5.5-mini` | `gpt-general` |
| `cliproxy/gpt-general` | `gpt-5.5-mini` | `cliproxy/gpt-general` |

## Reasoning Effort

Azure reasoning effort can be controlled centrally:

| Variable | Scope |
|---|---|
| `AZURE_OPENAI_GENERAL_REASONING_EFFORT` | Only requests through `gpt-general` |
| `AZURE_OPENAI_REASONING_EFFORT` | All Azure OpenAI reasoning models |

Alias-specific effort wins over the global value. Client-provided effort is used only when no env override exists.

## State and KV

For Chat Completions mode, cliProxy stores Azure response IDs in KV and uses `previous_response_id` on later turns when possible. This reduces repeated context and reasoning cost without exposing Responses state to Chat Completions clients.

For public Responses mode, cliProxy preserves the client's Responses contract and stores responses by default unless the request explicitly sets `store: false`, allowing clients such as Codex CLI to use `previous_response_id`.
