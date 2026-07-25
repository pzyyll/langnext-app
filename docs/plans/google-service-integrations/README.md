# Google Service Integrations Implementation Roadmap

**Goal:** Deliver a host-managed service integration system through vertical slices, starting with Google Cloud Translation v3beta1, then Google Web translation, Google Cloud Vision OCR, and Google Cloud Text-to-Speech.

**Inputs:** `docs/analysis/google-cloud-plugin-architecture.md`, current Provider/OCR/Profile architecture, and the requirement to replace `docs/plans/2026-07-24-google-translate-profile-plan.md`.

**Assumptions:**

- “Plugin” means bundled application-level service integration code in the current roadmap, not a downloadable Tauri/native plugin.
- User-configured records are named **integration instances** in persistence and IPC to avoid confusion with existing LLM `provider_instances`.
- Existing TypeScript LLM `ProviderPlugin` registration and execution remain unchanged through Phases 1–4.
- Rust is authoritative only for bundled service integrations and their capabilities.
- Existing Provider, global proxy, Baidu OCR, and AI OCR credential storage is not migrated in Phase 1.
- Google Cloud official services and Google Web/free translation are separate integration definitions.
- Google Cloud text-to-speech proceeds only through the locked Phase 4 scope; speech recognition, streaming/long audio, generic schema-rendered forms, WASM packages, and an installable plugin marketplace retain explicit future product gates.

**Architecture:** A bundled Rust integration registry exposes versioned, typed capabilities. Users create integration instances that own shared non-secret configuration and host-vault credential slots. Translation Profiles, OCR services, and Speech services reference an instance/capability and retain only runtime preferences. The host owns credential persistence, OAuth token grants, endpoint authorization, bounded HTTP, cancellation, error normalization, and observability.

**Tech Stack:** Tauri 2, Rust, SQLite/rusqlite, OS credential vault, reqwest, React 19, TanStack Router/Query, Effect IPC, Base UI, Tailwind CSS v4, i18next, Bun.

---

## Locked Decisions

| Topic                           | Decision                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plugin runtime                  | Bundled Rust service integrations first; no native dynamic libraries                                   |
| Catalog authority               | Rust for service integrations; TypeScript remains authoritative for LLM provider plugins               |
| Discovery bridge                | Frontend explicitly merges one LLM engine option with ready Rust integration capabilities              |
| Instance multiplicity           | Multiple instances per plugin definition are allowed                                                   |
| Google Cloud plugin ID          | `com.langnext.google-cloud`                                                                            |
| Google Web plugin ID            | `com.langnext.google-translate-web`                                                                    |
| Capability IDs                  | `translate.text@1`, `translate.detect@1`, `ocr.image@1`, `speech.synthesize@1`                         |
| Google official API             | Cloud Translation REST `v3beta1` only                                                                  |
| Official auth                   | Service-account JSON in host vault; OAuth access tokens minted by a trusted host driver                |
| Secret boundary                 | Secrets/tokens never appear in read DTOs, events, exports, logs, or plugin handler inputs              |
| Official endpoints              | Manifest-pinned; no user Base URL override                                                             |
| Google Cloud proxy mode         | Existing `inherit \| direct` only; no custom Base URL                                                  |
| Free endpoints                  | GTX pinned; optional proxy must be HTTPS, credential-free, and explicitly marked as third-party egress |
| Google Web default              | `gtx`, with persistent unofficial-endpoint warning                                                     |
| Profile engine type             | `llm_model_chain` or `plugin_capability`; immutable after create                                       |
| Google Translate preferences v1 | Empty object only; source/target languages remain common Profile fields; unknown keys rejected         |
| OCR engine type                 | Preserve `baidu` and `ai`; add `plugin_capability` in Phase 3                                          |
| Integration deletion            | `ON DELETE RESTRICT`; dependencies must be reassigned or removed explicitly                            |
| Forms                           | Host-owned typed forms through Phase 4; no generic schema renderer yet                                 |
| Route/label                     | Route `/plugins`; primary-nav label `Integrations`; `NavIconId` adds `extension`                       |
| External plugins                | WASM Component Model only after a real installable-plugin requirement                                  |

## Terminology

| Term                 | Meaning                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Plugin definition    | Bundled code, manifest, endpoint grants, credential slots, and capability handlers                  |
| Integration instance | One configured account/environment for a plugin definition                                          |
| Capability binding   | Profile/OCR/Speech record referencing an integration instance and capability                        |
| Credential slot      | Named secret binding owned by the host, e.g. `service-account-json`                                 |
| Token grant          | Host-authorized request for a short-lived provider token; not the token itself                      |
| Network broker       | Host service that enforces endpoint aliases, auth injection, limits, proxy policy, and cancellation |

## Stage Map

| Stage                                               | Deliverable                                                      | Depends on        | Release value                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- | ----------------- | ------------------------------------------------------ |
| [Phase 1A](./phase-1a-integration-core.md)          | Minimal registry, instance CRUD, credential slots, `/plugins`    | None              | Google Cloud account configured once                   |
| [Phase 1B](./phase-1b-google-cloud-translation.md)  | OAuth token grants, network broker, v3beta1 Translate/Detect     | Phase 1A          | Backend Google Cloud translation capability works      |
| [Phase 1C](./phase-1c-profile-runtime-ux.md)        | Plugin-backed Profiles, Translate/Quick Translate, import/export | Phase 1B          | Google Cloud Translation is user-facing and releasable |
| [Phase 2](./phase-2-google-web-translation.md)      | Separate GTX/HTTPS proxy integration                             | Phase 1C          | Credential-free Google translation choices             |
| [Phase 3](./phase-3-google-cloud-vision-ocr.md)     | Vision OCR reusing the Cloud instance                            | Phase 1C          | One Cloud credential serves Translate + OCR            |
| [Phase 4](./phase-4-google-cloud-text-to-speech.md) | Google Cloud TTS services and Translate playback                 | Phase 3           | Source/result text can be synthesized and played       |
| [Future gates](./future-gates.md)                   | STT/streaming/schema UI/WASM entry criteria                      | Real product need | Prevent speculative infrastructure                     |

```text
Phase 1A → Phase 1B → Phase 1C → Phase 2
                              └→ Phase 3 → Phase 4 (TTS)
                                             └→ Remaining Speech gates
```

## Migration Order

| Migration                                  | Stage    | Responsibility                                                         |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| `0012_service_integrations.sql`            | Phase 1A | Integration instances, credential slots, slot-aware credential journal |
| `0013_translation_profile_engines.sql`     | Phase 1C | LLM/plugin Profile engine discriminant and integration FK              |
| `0014_ocr_service_integration_binding.sql` | Phase 3  | OCR plugin capability binding while preserving Baidu/AI rows           |
| `0015_speech_services.sql`                 | Phase 4  | Capability-backed Speech services using shared integration instances   |

Each migration must pass both fresh-database and upgrade-from-previous-version tests. `src-tauri/src/storage/migrations.rs` remains the ordered embed list.

## Data Ownership

```text
integration_instances
  ├─ non-secret config_json
  ├─ persisted health_status (unconfigured | unvalidated | ready | degraded)
  ├─ DTO effectiveStatus derives disabled/plugin_missing from enabled + registry lookup
  └─ integration_credential_bindings
       └─ opaque vault ref + credential revision

translation_profiles
  └─ engine_kind
       ├─ llm_model_chain → existing targets/templates
       └─ plugin_capability → integration_instance + capability + preferences

ocr_services
  └─ provider_type
       ├─ baidu → existing native path
       ├─ ai → existing TS model/prompt path
       └─ plugin_capability → integration_instance + capability + preferences

speech_services
  └─ integration_instance + speech.synthesize@1 + speaking preferences
```

## Cross-Cutting Requirements

### Security

- Host validates and stores credential replacement input; secret values are write-only.
- Service-account JSON validation requires bounded size plus `client_email`, `private_key`, and pinned `token_uri`.
- Token cache keys include integration instance ID, credential revision, and normalized scope set.
- Credential replace/clear immediately evicts cached grants.
- Capability handlers cannot choose arbitrary OAuth endpoints, scopes, audiences, or HTTP origins.
- Official Google endpoint aliases are pinned in the bundled manifest.
- Free proxy integration never receives Cloud credentials or auth headers.
- User content, image/audio bytes, raw provider bodies, credentials, and tokens are excluded from normal logs.

### Failure model

Stable integration/capability errors:

```text
invalid_configuration
credential_unavailable
auth
permission_denied
quota_exceeded
rate_limited
unsupported_input
unsupported_language
network
timeout
invalid_response
provider_unavailable
plugin_unavailable
cancelled
in_use
conflict
internal
```

Errors may include bounded `retryable`, `providerCode`, `capabilityId`, and `requestId` metadata, but never raw provider bodies.

### Frontend state

- TanStack Query caches integration DTOs.
- Rust/SQLite remains authoritative.
- `data://service-integrations-changed` is an invalidation signal only.
- Effect stays in typed IPC/workflows; routes consume Promise runners/helpers.
- Streaming/session state remains outside Query.

### Import/export

- Phase 1C introduces export format v4 with `integrationInstances` and engine-tagged Profiles.
- Phase 3 introduces v5 with OCR services/templates and default OCR reference remapping.
- Phase 4 introduces v6 with Speech services and default Speech reference remapping; synthesis text/audio remains excluded.
- Import accepts an untrusted raw JSON value, reads `formatVersion` first, then runs explicit normalizers: v2→v3→v4→v5→v6.
- Supported-version checks use an explicit set/range, not one `PREVIOUS_EXPORT_FORMAT_VERSION` constant.
- Secrets and vault refs are always omitted.
- Imported integration instances require credential re-entry.
- Missing bundled plugin definitions remain visible as `plugin_missing` and fail closed.

## Global File Map

### New backend areas

- `src-tauri/src/domain/service_integration.rs` — manifest/instance/slot DTOs.
- `src-tauri/src/domain/service_capability.rs` — typed capability requests/results/errors.
- `src-tauri/src/repositories/integration_instances.rs` — instance persistence.
- `src-tauri/src/repositories/integration_credential_bindings.rs` — credential-slot persistence.
- `src-tauri/src/services/service_integration_registry.rs` — bundled definition/capability registration.
- `src-tauri/src/services/service_integrations.rs` — instance CRUD, validation, dependencies, credential orchestration.
- `src-tauri/src/services/token_grant.rs` — host token-grant broker/cache.
- `src-tauri/src/services/bounded_http.rs` — shared low-level limits/cancellation/redirect-safe transport.
- `src-tauri/src/services/network_broker.rs` — endpoint-authorized bounded transport.
- `src-tauri/src/services/service_capabilities.rs` — typed handler lookup/dispatch.
- `src-tauri/src/services/google_service_account.rs` — trusted Google JWT/token driver.
- `src-tauri/src/services/google_cloud.rs` — Google Cloud capabilities.
- `src-tauri/src/cmds/service_integrations.rs` — catalog/instance IPC.
- `src-tauri/src/cmds/service_translation.rs` — plugin-profile translation/detection IPC.
- `src-tauri/src/domain/speech_service.rs` — capability-backed Speech service DTOs and synthesis input.
- `src-tauri/src/repositories/speech_services.rs` — Speech service persistence and dependency lookup.
- `src-tauri/src/services/speech_services.rs` — Speech CRUD/default resolution and synthesis dispatch.
- `src-tauri/src/cmds/speech_services.rs` — Speech CRUD/synthesis/cancellation IPC.

### New frontend areas

- `src/features/plugins/` — catalog, instance editor, typed Google forms, dependency/status UX.
- `src/routes/plugins.tsx` — route layout.
- `src/routes/plugins/index.tsx` — empty selection route.
- `src/routes/plugins/$integrationInstanceId.tsx` — instance editor route.
- `src/features/translate/AddTranslationProfileDialog.tsx` — LLM + integration-capability chooser.
- `src/features/translate/translationEngineOptions.ts` — explicit dual-catalog merge.
- `src/features/speech/` — Speech service management and one-audio playback orchestration.
- `src/routes/speech.tsx`, `src/routes/speech/` — Speech layout, empty state, and editor routes.

## Stage Exit Rules

A phase is complete only when:

1. Every task in its phase file is complete.
2. Targeted tests pass.
3. Full validation passes.
4. New migrations pass fresh and upgrade tests.
5. Security assertions have automated coverage.
6. Manual Tauri smoke checks for that phase pass.
7. No existing LLM, Baidu OCR, or AI OCR behavior regresses.

## Final Validation

Run at each phase exit:

```bash
mise run format:check
mise run lint
mise run typecheck
mise run test-frontend
mise run test
mise run build
```

Expected: Prettier/rustfmt, ESLint, TypeScript, Bun tests, Rust tests, and frontend production build all pass.

Run desktop smoke validation:

```bash
mise run tauri:dev
```

Expected: the phase-specific manual checklist passes with no secret exposure in UI/logs/export.

## Rollout Notes

- Release Phase 1 only after 1A, 1B, and 1C are all complete; 1A/1B are internal milestones.
- Phase 2 and Phase 3 are independent after Phase 1C.
- Phase 4 follows Phase 3 and reuses its capability-binding and OCR-style service-management patterns.
- Do not implement tasks from the superseded profile-owned Google plan.
- Do not manually edit `src/routeTree.gen.ts`; regenerate it through the TanStack Router plugin and commit the generated result.

## Open Questions

None blocking Phase 1 planning. Phase-specific gates are recorded in the corresponding files.
