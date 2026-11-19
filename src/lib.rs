//! Native extension entry. Add exports only when a feature needs Rust.

use nsh_core::prelude::*;

mod quick_translate;

/// Registers the application's native exports with NSH.
#[native_module("my-translator/native")]
fn native(registry: &mut Registry) {
    registry.module::<quick_translate::QuickTranslateNative>();
}
