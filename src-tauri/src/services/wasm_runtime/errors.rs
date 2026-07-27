// ABOUTME: Sanitized Wasm runtime error mapping from Wasmtime traps/limits and guest
// ABOUTME: plugin-errors to the host's stable CapabilityError codes.
// No guest stack traces, user content, provider bodies, or host paths reach IPC-facing errors.
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};

/// Map a Wasmtime host-side error (trap, fuel/epoch exhaustion, out-of-memory, instantiate
/// failure) to a stable, sanitized `CapabilityError`. Classification prefers Wasmtime's
/// structured `Trap` code; the display string is never returned to callers (it may contain
/// guest backtraces, paths, or user content).
pub fn map_wasmtime_error(error: wasmtime::Error) -> CapabilityError {
  // Structured trap classification first: fuel/memory-exhaustion are resource limits; other
  // traps (unreachable, stack overflow) are sanitized plugin-unavailable failures.
  if let Some(trap) = error.downcast_ref::<wasmtime::Trap>() {
    let (code, label) = match trap {
      wasmtime::Trap::OutOfFuel | wasmtime::Trap::MemoryOutOfBounds => {
        (CapabilityErrorCode::QuotaExceeded, "guest resource limit exceeded")
      }
      wasmtime::Trap::TableOutOfBounds | wasmtime::Trap::IndirectCallToNull => (
        CapabilityErrorCode::InvalidResponse,
        "guest invoked an invalid table element",
      ),
      wasmtime::Trap::StackOverflow => (CapabilityErrorCode::QuotaExceeded, "guest stack limit exceeded"),
      wasmtime::Trap::HeapMisaligned | wasmtime::Trap::CannotEnterComponent => {
        (CapabilityErrorCode::PluginUnavailable, "guest execution trapped")
      }
      _ => (CapabilityErrorCode::PluginUnavailable, "guest execution trapped"),
    };
    return CapabilityError::new(code, label);
  }
  // Structured out-of-memory (pooling allocator exhaustion).
  if error.downcast_ref::<wasmtime::OutOfMemory>().is_some() {
    return CapabilityError::new(CapabilityErrorCode::QuotaExceeded, "guest resource limit exceeded");
  }
  // Fallback: inspect the full error chain (including causes) for resource-limit
  // keywords. The StoreLimits limiter uses bail! which appears as a cause, not the top-level
  // error. The display string is never returned to callers; only the stable code and label.
  let lower = error
    .chain()
    .flat_map(|cause| cause.to_string().to_ascii_lowercase().chars().collect::<Vec<_>>())
    .collect::<String>();
  if lower.contains("memory")
    || lower.contains("table")
    || lower.contains("forcing trap")
    || lower.contains("limit")
    || lower.contains("fuel")
    || lower.contains("epoch")
  {
    return CapabilityError::new(CapabilityErrorCode::QuotaExceeded, "guest resource limit exceeded");
  }
  CapabilityError::new(CapabilityErrorCode::Internal, "guest execution failed")
}

/// Map a component compile/instantiate failure to a stable capability error without leaking
/// internal details. Compile/instantiate failures are not cached. Uses structured error
/// downcasting where possible; falls back to a generic plugin-unavailable code.
pub fn map_instantiate_error(error: wasmtime::Error) -> CapabilityError {
  // Try structured trap first (e.g. memory/table limit traps during instantiation).
  if let Some(trap) = error.downcast_ref::<wasmtime::Trap>() {
    let (code, label) = match trap {
      wasmtime::Trap::MemoryOutOfBounds => (
        CapabilityErrorCode::InvalidConfiguration,
        "guest memory declaration exceeds host limit",
      ),
      _ => (
        CapabilityErrorCode::PluginUnavailable,
        "plugin component failed to instantiate",
      ),
    };
    return CapabilityError::new(code, label);
  }
  // Structured out-of-memory during instantiation (pooling allocator or store limit).
  if error.downcast_ref::<wasmtime::OutOfMemory>().is_some() {
    return CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "guest resource declaration exceeds host limit",
    );
  }
  // The display string may contain linker/import details, paths, or guest internals; never
  // return it. Classify resource-declaration failures (oversized memory/table minimums) as
  // InvalidConfiguration; unknown imports and other instantiate failures stay PluginUnavailable.
  let lower = error
    .chain()
    .flat_map(|cause| cause.to_string().to_ascii_lowercase().chars().collect::<Vec<_>>())
    .collect::<String>();
  if lower.contains("memory")
    || lower.contains("table")
    || lower.contains("minimum")
    || lower.contains("too large")
    || lower.contains("exceed")
    || lower.contains("limit")
  {
    return CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "guest resource declaration exceeds host limit",
    );
  }
  CapabilityError::new(
    CapabilityErrorCode::PluginUnavailable,
    "plugin component failed to compile or instantiate",
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn map_wasmtime_error_never_leaks_display() {
    // A trap with a message that looks like it contains user content and a path.
    let error = wasmtime::Error::from(wasmtime::Trap::UnreachableCodeReached);
    let mapped = map_wasmtime_error(error);
    assert_eq!(mapped.code, CapabilityErrorCode::PluginUnavailable);
    // The message is a fixed label, never the trap display.
    assert_eq!(mapped.message, "guest execution trapped");
    assert!(!mapped.message.contains("secret"));
    assert!(!mapped.message.contains("C:\\"));
  }

  #[test]
  fn map_out_of_fuel_to_quota_exceeded() {
    let error = wasmtime::Error::from(wasmtime::Trap::OutOfFuel);
    let mapped = map_wasmtime_error(error);
    assert_eq!(mapped.code, CapabilityErrorCode::QuotaExceeded);
  }

  #[test]
  fn map_memory_out_of_bounds_to_quota_exceeded() {
    let error = wasmtime::Error::from(wasmtime::Trap::MemoryOutOfBounds);
    let mapped = map_wasmtime_error(error);
    assert_eq!(mapped.code, CapabilityErrorCode::QuotaExceeded);
  }

  #[test]
  fn map_instantiate_error_never_leaks_details() {
    let error = wasmtime::Error::msg("unknown import `wasi_snapshot_preview1::fd_write` /path/to/guest.rs");
    let mapped = map_instantiate_error(error);
    // The message is a fixed label, never the error display.
    assert!(!mapped.message.contains("wasi_snapshot_preview1"));
    assert!(!mapped.message.contains("/path/to/guest.rs"));
    assert!(!mapped.message.contains("fd_write"));
  }
}
