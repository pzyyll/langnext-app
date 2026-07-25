# Edge TTS Plugin Integration Plan

## Goal

Integrate Microsoft Edge TTS (via the OpenAI-compatible `tts.wangwangit.com` API) as a
bundled credential-free speech plugin, reusing the existing plugin / capability / speech
service architecture.

- API: `POST {baseUrl}/v1/audio/speech` with JSON `{ input, voice, speed, pitch, style }`,
  returns raw MP3 bytes. No auth. Default base URL `https://tts.wangwangit.com`.
- Voices: 21 Chinese (`zh-CN-*`) voices; text may be any language.
- User decisions: configurable base URL (self-hostable); voice selection lives in the Speech
  service preferences.

## Architecture fit

The app models plugins as `ServiceIntegrationManifest` (capabilities + endpoints + credential
slots). Integration instances bind config + health; capability handlers implement
`SpeechSynthesizeCapability`; Speech services bind an instance + capability + preferences.

Edge TTS is credential-free (like `google-translate-web`) and reuses `speech.synthesize@1`.

## Key constraints and decisions

1. **Binary MP3 response**: `NetworkBroker.execute()` returns `ProviderHttpResponse.body:
String` via `String::from_utf8`, which rejects raw MP3. The Edge TTS handler therefore
   calls `reqwest` directly (self-contained), reading the base URL from instance config. It
   enforces input/output size limits, timeout, and cancellation itself. The broker is
   bypassed only for this credential-free binary plugin; `ServiceCapabilityService` still
   gates instance/capability/health state.
2. **Configurable endpoint**: `EdgeTtsConfigV1.baseUrl` (default
   `https://tts.wangwangit.com`). Validated/normalized at save like the Google Web proxy URL.
3. **Plugin-specific speech preferences**: `SpeechSynthesizeRequest.preferences` changes from
   the Google `SpeechSynthesizePreferences` to `serde_json::Value`. Host validation in
   `speech_services.rs` dispatches by `plugin_id`; each handler parses its own schema.
   - Google schema v1: `{ speakingRate, pitch }` (unchanged).
   - Edge schema v1: `{ voice, speed, pitch, style }`.

## Backend changes

- `domain/service_integration.rs`: `EDGE_TTS_PLUGIN_ID`, `EDGE_TTS_DEFAULT_BASE_URL`,
  `EDGE_TTS_BASE_URL_MAX_LEN`, `EdgeTtsConfigV1`.
- `domain/speech_service.rs`: `EDGE_TTS_PREFERENCES_SCHEMA_VERSION`, `EdgeTtsPreferences`,
  `default_edge_tts_preferences`, `parse_edge_tts_preferences`.
- `domain/service_capability.rs`: `SpeechSynthesizeRequest.preferences` -> `Value`;
  `validate_edge_tts_preferences`, `EDGE_TTS_*` bounds (voice list, speed 0.5-2.0, pitch
  -50..50, style enum).
- `services/edge_tts.rs` (new): `EdgeTtsCapabilities` implementing
  `SpeechSynthesizeCapability`; `validate_edge_tts_config`, `edge_tts_config_complete`,
  `normalize_edge_tts_base_url`, `parse_edge_tts_speech_response`.
- `services/service_integration_registry.rs`: `edge_tts_manifest()` + register in `bundled()`.
- `services/service_capabilities.rs`: impl `SpeechSynthesizeCapability for
EdgeTtsCapabilities`; `with_edge_tts`.
- `services/speech_services.rs`: plugin-aware preference parse/validate in
  `validate_plugin_binding` + `prepare_speech_synthesis`; pass raw `Value` to handler.
- `services/service_integrations.rs`: Edge TTS branch in `validate_config_for_plugin` +
  `plugin_config_complete`.
- `services/google_cloud.rs`: `synthesize_speech` parses Google prefs from the `Value`.
- `services/mod.rs`: declare `edge_tts`.
- `state.rs`: construct + register `EdgeTtsCapabilities`.

## Frontend changes

- `storage/types.ts`: `EDGE_TTS_PLUGIN_ID`, `EDGE_TTS_DEFAULT_BASE_URL`,
  `EdgeTtsConfigV1`, `EdgeTtsPreferencesV1`, `EDGE_TTS_PREFERENCES_SCHEMA_VERSION`,
  voice/style option lists.
- `features/plugins/integrationDraft.ts`: Edge draft helpers.
- `features/plugins/EdgeTtsIntegrationForm.tsx` (new): base URL field.
- `features/plugins/AddIntegrationDialog.tsx` + `IntegrationEditor.tsx`: Edge option/form.
- `features/speech/speechProviderOptions.ts`: Edge constants + create options + icon.
- `features/speech/EdgeTtsForm.tsx` (new): voice select + speed/pitch/style.
- `features/speech/SpeechServiceEditor.tsx`: plugin-aware draft + form dispatch.
- `features/speech/AddSpeechServiceDialog.tsx`: plugin-aware preferences seed.
- `i18n/locales/{en,zh-CN}.ts`: `plugins.edgeTts.*`, `speech.edgeTts.*`, voice labels.

## Validation

`cargo test` (backend), `mise run typecheck`, `mise run lint`.
