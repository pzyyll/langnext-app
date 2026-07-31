// ABOUTME: Wasm Component runtime service: bounded, typed execution of langnext runtime-plugin
// ABOUTME: Components. Shared Engine, per-request Store, narrow host imports, no WASI.
//! Phase 2 Wasm Component runtime. See
//! `docs/plans/runtime-plugin-system/phase-2-wasm-runtime.md`.
//!
//! A shared [`engine::WasmEngine`] compiles typed Components. Each invocation creates a fresh
//! `Store<store::PluginHostState>` with a principal, approved grant set, cancellation, deadline,
//! broker handle, and strict limits. The linker exposes only LangNext WIT interfaces and never
//! links WASI.

pub mod bindings;
pub mod cache;
pub mod engine;
pub mod errors;
pub mod executor;
pub mod host;
pub mod network_handle;
pub mod store;

// Re-export the verified-component boundary type and typed capability adapters.
pub use executor::{
  VerifiedComponent, WasmDetectLanguageAdapter, WasmRuntime, WasmSpeechSynthesizeAdapter, WasmTranslateTextAdapter,
};

#[cfg(test)]
mod tests;
