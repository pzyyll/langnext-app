# Provider Plugin + Native Transport Boundary

## Goal

Frontend TypeScript Provider plugins own wire formats, response parsing, SSE
interpretation, pagination, and detect/translate/OCR-AI policy. Rust retains
credential storage, generic auth injection, bounded HTTP transport, proxy
handling, cancellation, and persistence.

## Layout

```text
src/features/providers/
  types.ts              ProviderPlugin contract, wire/SSE types
  registry.ts           registration + auth compatibility
  providerFetch.ts      fetch-like facade over provider_http_* IPC
  sse.ts                incremental UTF-8 + SSE decoder
  errors.ts             generic HTTP/IPC error normalization
  builtin/              OpenAI Compatible/Responses, Anthropic, Gemini, DeepSeek

src/features/ocr/recognizeOcrFlow.ts   AI OCR via plugins; Baidu stays native

src-tauri/src/
  domain/provider_http.rs
  services/provider_http.rs
  cmds/provider_http.rs
```

There is **no** `src-tauri/src/adapters/` module. Provider wire formats are not
implemented in Rust.

## Plugin contract

| Method                                                        | Responsibility                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `manifest`                                                    | id, label, default Base URL, credential kinds, capabilities |
| `resolveAuthScheme`                                           | map `CredentialKind` → versioned `AuthSchemeV1`             |
| `buildModelListRequest` / `parseModelListPage`                | model list wire + pagination                                |
| `buildChatRequest` / `parseChatResponse` / `parseStreamEvent` | chat wire format                                            |
| `getDetectPolicy`                                             | thinking toggle + max_tokens for language detection         |

## Native transport

Authenticated Provider traffic uses `providerFetch` / `providerFetchStream`:

1. Plugin builds an unsigned relative `ProviderWireRequest`.
2. Rust resolves the provider Base URL, proxy mode, and vault secret.
3. Rust injects auth (`none` / `bearer` / `header` / `query`) natively.
4. Raw status/body or Channel byte chunks return to the frontend.

Rules:

- Only relative paths are accepted; redirects are disabled.
- Sensitive caller headers/query keys are rejected before secret lookup.
- Secrets and credential references never cross IPC DTOs.
- Stock `@tauri-apps/plugin-http` is optional for public/no-secret traffic only.

## Auth scheme expansion

New auth mechanisms (SigV4, mTLS, OAuth refresh) require a native platform change
to `AuthSchemeV1` and `ProviderHttpService`. Ordinary providers that use
existing schemes need only a TypeScript plugin registration.

## Model API Type overrides

Executable only when auth schemes are compatible and either:

- provider `baseUrlSource=custom` (shared relay), or
- override plugin id equals the provider plugin id.

Otherwise execution fails closed with `provider_reconfiguration_required`.

## Registration

Built-ins register through `registerProviderPlugin` (same API future external
plugins will use). Duplicate IDs fail at registration. Missing plugins remain
visible in persisted DTOs but return `plugin_unavailable` at execution.

## Residual native paths

- **Baidu OCR** remains a native REST integration (not a Provider plugin).
- **AI OCR** uses the same frontend plugin + `providerFetch` path as chat.
