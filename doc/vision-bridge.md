# Vision Bridge

The vision bridge lets text-only chat providers receive useful image context.

It applies to:

- DeepSeek
- MiniMax

It is skipped for:

- Azure OpenAI
- Azure Anthropic
- Kimi

## Flow

```mermaid
sequenceDiagram
    participant C as Chat Completions client
    participant P as vscodeProxy
    participant V as Vision backend
    participant U as Text-only upstream

    C->>P: POST /v1/chat/completions with image_url blocks
    P->>V: Describe images
    V-->>P: Text descriptions
    P->>U: Forward text-only messages
    U-->>P: Model response
    P-->>C: OpenAI Chat Completions response
```

## Backends

| Provider | Variables |
|---|---|
| MiniMax VL default | `MINIMAX_API_KEY` |
| OpenAI-compatible vision | `VISION_API_PROVIDER=openai`, `VISION_API_KEY`, optional `VISION_API_URL`, `VISION_MODEL` |

Useful tuning:

```env
VISION_TIMEOUT_MS=15000
VISION_CONCURRENCY=2
```

Set `VISION_TIMEOUT_MS=0` to disable per-image timeout on runtimes without a pre-stream wall-clock limit.

## Allowed Image URL Schemes

By default the vision bridge only forwards `data:` image URIs to the configured backend. Inline base64 payloads from VS Code OAI / Codex are accepted as-is.

`http(s)` URLs that some clients embed (remote screenshots, public CDN links) are **rejected** by default — they would otherwise cause the upstream vision provider (MiniMax / OpenAI) to perform an HTTP fetch on the client's behalf, which can be used to probe networks that the upstream can reach.

To accept remote image URLs:

```env
VISION_ALLOW_REMOTE_URLS=true
```

Even with this enabled, hostnames resolving to loopback (`127.0.0.0/8`, `::1`, `localhost`), link-local (`169.254.0.0/16`, `fe80::/10`, including the cloud metadata endpoint `169.254.169.254`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), ULA (`fc00::/7`), or multicast / reserved ranges are still rejected. Rejected image parts are replaced with `(image attachment unavailable: unsupported image URL scheme)` and the rest of the request proceeds.

## Error Behavior

If every image conversion fails for a non-streaming request, vscodeProxy returns a clear upstream error instead of forwarding ignored image blocks to a text-only model.

For streaming requests, failed image conversions are represented with placeholder text so the stream can still begin.

## Responses Endpoint

The vision bridge is only for Chat Completions requests. `/v1/responses` currently routes to Azure OpenAI, which can handle native multimodal Responses inputs according to the configured Azure model.
