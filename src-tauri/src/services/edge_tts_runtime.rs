// ABOUTME: Edge TTS Wasm runtime adapter constants and vendor-default qualification.
// ABOUTME: The host auto-pins the verified com.langnext.edge-tts vendor package for new instances.
//!
//! # Edge TTS runtime wiring
//!
//! This module holds the host-side constants for the `com.langnext.edge-tts` Wasm package so the
//! runtime lifecycle can bind a verified vendor package to the `speech.synthesize@1` capability.
//! The actual Wasm adapter registration runs through [`crate::services::wasm_runtime::executor`]
//! (`WasmSpeechSynthesizeAdapter`), and the vendor-default qualification lives in
//! [`crate::services::runtime_lifecycle::is_edge_tts_vendor_default`].
//!
//! ## Vendor package seeding (mirrors Google Web GTX)
//!
//! [`crate::services::runtime_lifecycle::RuntimeLifecycleService::pin_default_package_for_new_instance`]
//! auto-pins the committed `com.langnext.edge-tts-1.0.0` package for freshly created Edge TTS
//! instances. The host reverse-binds the verified manifest against the external vendor root:
//!
//! 1. Cross-bind package digest: `verified.package_digest == version.package_digest`.
//! 2. Cross-bind plugin id: `manifest.id == EDGE_TTS_PACKAGE_ID && version.plugin_id == manifest.id`.
//! 3. Cross-bind version: `manifest.version == EDGE_TTS_PACKAGE_VERSION && version.version == EDGE_TTS_PACKAGE_VERSION`.
//! 4. Cross-bind runtime kind: `manifest.runtime.kind == WasmComponent`.
//! 5. Cross-bind publisher key id/fingerprint/public key against the vendor root; reject revoked
//!    or non-vendor publishers.
//! 6. Cross-bind network endpoint: exactly one `tts-api` endpoint with POST method,
//!    `instance_origin_config_field == "base-url"`, and no static origins. The effective origin is
//!    resolved from the migrated config's `base-url` field (vendor default:
//!    `https://tts.wangwangit.com`).
//! 7. Cross-bind capability: `speech.synthesize@1` with a preferences schema and the
//!    `fixtures/langnext-edge-tts.wasm` artifact.
//!
//! Instance migration/upgrade preserves Speech service/default references: the lifecycle
//! snapshots pre-migration preference rows and restores them on rollback (see
//! `runtime_lifecycle_preference_tests`). Production speech synthesis executes Wasm + broker +
//! Blob for pinned instances via [`crate::services::service_capabilities::ServiceCapabilityService::resolve_speech_synthesize`];
//! the bundled `EdgeTtsCapabilities` in [`crate::services::edge_tts`] remains as rollback.

// Re-export existing transport constants so runtime wiring has one import surface and the values
// cannot drift between the bundled executor and the Wasm package contract.
pub use crate::domain::service_capability::SPEECH_SYNTHESIZE_CAPABILITY_ID as EDGE_TTS_CAPABILITY_ID;
pub use crate::domain::service_integration::{EDGE_TTS_DEFAULT_BASE_URL, EDGE_TTS_PLUGIN_ID as EDGE_TTS_PACKAGE_ID};
pub use crate::services::edge_tts::{EDGE_TTS_ENDPOINT_ALIAS, EDGE_TTS_SYNTHESIZE_PATH};

/// Wasm package version this host build accepts as the vendor default (matches plugin.json).
pub const EDGE_TTS_PACKAGE_VERSION: &str = "1.0.0";
/// Default HTTPS origin approved for the `tts-api` endpoint (origin of the default base URL).
pub const EDGE_TTS_VENDOR_DEFAULT_ORIGIN: &str = EDGE_TTS_DEFAULT_BASE_URL;
/// Host-resolved auth policy: Edge TTS is credential-free.
pub const EDGE_TTS_AUTH_POLICY: &str = "host.none.v1";
/// Runtime artifact path inside the package (relative to the package root).
pub const EDGE_TTS_ARTIFACT_PATH: &str = "fixtures/langnext-edge-tts.wasm";
/// Config schema path inside the package.
pub const EDGE_TTS_CONFIG_SCHEMA_PATH: &str = "schemas/config.json";
/// Preferences schema path inside the package.
pub const EDGE_TTS_PREFERENCES_SCHEMA_PATH: &str = "schemas/speech-preferences.json";
/// Config field name for the instance-configured TTS base URL origin.
pub const EDGE_TTS_BASE_URL_CONFIG_FIELD: &str = "base-url";
