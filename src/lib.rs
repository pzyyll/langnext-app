//! Native extension entry. Add exports only when a feature needs Rust.

use nsh_core::prelude::*;

pub mod app_paths;
pub mod quick_translate;
pub mod screen_capture;
pub mod selection_text;
mod translation_history;

/// Registers the application's native exports with NSH.
#[native_module("my-translator/native")]
fn native(registry: &mut Registry) {
    registry.module::<app_paths::AppPathsNative>();
    registry.module::<quick_translate::QuickTranslateNative>();
    registry.module::<screen_capture::ScreenCaptureNative>();
    registry.module::<selection_text::SelectionTextNative>();
    registry.module::<translation_history::TranslationHistoryNative>();
}
