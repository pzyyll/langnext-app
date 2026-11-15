//! Native extension entry. Add exports only when a feature needs Rust.

use nsh_core::prelude::*;

/// Registers the application's native exports with NSH.
#[native_module("my-translator/native")]
fn native(_registry: &mut Registry) {}
