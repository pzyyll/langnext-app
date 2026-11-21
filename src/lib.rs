//! Native extension entry. Add exports only when a feature needs Rust.

use nsh_core::prelude::*;

pub mod quick_translate;
pub mod screen_capture;
pub mod selection_text;

/// Registers the application's native exports with NSH.
#[native_module("my-translator/native")]
fn native(registry: &mut Registry) {
    registry.module::<quick_translate::QuickTranslateNative>();
    registry.module::<screen_capture::ScreenCaptureNative>();
    registry.module::<selection_text::SelectionTextNative>();
}
