# Provider Adapter Strategy

## Goal

Own each provider API family behind a single strategy interface so wire format,
auth, pagination, stream parsing, and detect/translate policy live together.
Transport only orchestrates HTTP, proxy, timeouts, and SSE framing.

## Layout

```text
src-tauri/src/adapters/
  protocol.rs     ProviderAdapter trait + DetectChatPolicy
  registry.rs     id → strategy map (plugin-style register/get/list)
  catalog.rs      metadata + validation facade for services
  transport.rs    shared HTTP / SSE orchestration
  builtin/
    openai_compatible.rs
    openai_responses.rs
    anthropic.rs
    gemini.rs
    deepseek.rs
    openai_shared.rs   shared OpenAI chat.completions helpers
```

## Strategy contract

`ProviderAdapter` methods:

| Method | Responsibility |
| --- | --- |
| `meta` | id, label, default base URL |
| `secret_required` / `auth_application` | credential policy |
| `models_path` / `parse_models_page` / `apply_list_continuation` | model list |
| `build_chat` / `parse_chat_content` / `parse_stream_delta` | chat wire format |
| `finalize_stream_url` | stream-only URL tweaks (e.g. Gemini `alt=sse`) |
| `detect_chat_policy` | thinking toggle + max_tokens for language detection |
| `validate_profile_options` | per-adapter option schema (empty for now) |

## Registry

Built-ins load on first lookup via `registry::ensure_loaded()`.

```rust
// future plugin / test registration
registry::register(registry::wrap(MyAdapter));
```

Unknown adapter ids fail closed (`StorageError::Validation` for services,
`TransportError::InvalidResponse` for transport).

## DeepSeek

`deepseek` is a first-class adapter:

- Wire format: OpenAI chat.completions (via `openai_shared`)
- Default base URL: `https://api.deepseek.com`
- Detect policy: `thinking: disabled`, raised `max_tokens` (2048)

`openai-compatible` keeps a small relay heuristic (`model_key` / `base_url`
contains `deepseek`) so existing relay configs keep working. Prefer the
dedicated `deepseek` adapter for new providers.

## Service boundary

`ModelService` no longer branches on DeepSeek:

```rust
let detect_policy = catalog::detect_chat_policy(&adapter_id, &model_key, &base_url);
```

`secret_required` is also delegated to the strategy via `catalog`.

## Frontend

`src/features/models/adapterOptions.ts` mirrors the registry catalog until a
catalog IPC endpoint exists.
