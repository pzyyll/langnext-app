// ABOUTME: Synthetic migration-world guest for Phase 4 runtime lifecycle conformance.
// ABOUTME: serde_json recursive object-key rename label→title; rejects malformed JSON.
#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;

/// no_std wasm guests do not provide libc `memcmp`; implement a minimal one for slice compares.
#[no_mangle]
pub unsafe extern "C" fn memcmp(s1: *const c_void, s2: *const c_void, n: usize) -> i32 {
  let a = core::slice::from_raw_parts(s1 as *const u8, n);
  let b = core::slice::from_raw_parts(s2 as *const u8, n);
  for i in 0..n {
    let d = a[i] as i32 - b[i] as i32;
    if d != 0 {
      return d;
    }
  }
  0
}

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "migration-world",
  std_feature,
});

use exports::langnext::runtime_plugin::migration::Guest;
use langnext::runtime_plugin::common::PluginError;
use serde_json::Value;

/// Compatible path: schema 1 → 2 renames object key `label` → `title` (values unchanged).
const COMPAT_FROM: u32 = 1;
const COMPAT_TO: u32 = 2;

struct Component;

impl Guest for Component {
  fn migrate_config(from_version: u32, to_version: u32, config: Vec<u8>) -> Result<Vec<u8>, PluginError> {
    if from_version == to_version {
      return Ok(config);
    }
    if from_version == COMPAT_FROM && to_version == COMPAT_TO {
      return rewrite_json_label_keys(&config);
    }
    if to_version >= 9 {
      return Err(PluginError::InvalidConfiguration);
    }
    Err(PluginError::InvalidConfiguration)
  }

  fn migrate_preferences(
    _capability: String,
    from_version: u32,
    to_version: u32,
    preferences: Vec<u8>,
  ) -> Result<Vec<u8>, PluginError> {
    if from_version == to_version {
      return Ok(preferences);
    }
    if from_version == COMPAT_FROM && to_version == COMPAT_TO {
      return rewrite_json_label_keys(&preferences);
    }
    if to_version >= 9 {
      return Err(PluginError::InvalidConfiguration);
    }
    Err(PluginError::InvalidConfiguration)
  }
}

/// Parse JSON, recursively rename object keys `label` → `title`, re-serialize.
/// Malformed JSON fails closed. Unicode-escaped keys (e.g. `\u006cabel`) are parsed then renamed.
fn rewrite_json_label_keys(input: &[u8]) -> Result<Vec<u8>, PluginError> {
  if input.iter().all(|b| b.is_ascii_whitespace()) {
    return Ok(b"{}".to_vec());
  }
  let mut value: Value =
    serde_json::from_slice(input).map_err(|_| PluginError::InvalidConfiguration)?;
  rename_label_keys(&mut value);
  serde_json::to_vec(&value).map_err(|_| PluginError::InvalidConfiguration)
}

fn rename_label_keys(value: &mut Value) {
  match value {
    Value::Object(map) => {
      // Collect renames first to avoid borrow conflicts.
      let mut pending: Vec<(String, Value)> = Vec::new();
      let keys: Vec<String> = map.keys().cloned().collect();
      for key in keys {
        if key == "label" {
          if let Some(v) = map.remove(&key) {
            pending.push((String::from("title"), v));
          }
        }
      }
      for (k, v) in pending {
        map.insert(k, v);
      }
      for child in map.values_mut() {
        rename_label_keys(child);
      }
    }
    Value::Array(items) => {
      for item in items.iter_mut() {
        rename_label_keys(item);
      }
    }
    _ => {}
  }
}

use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicUsize, Ordering};

const HEAP_SIZE: usize = 512 * 1024;
struct Bump {
  head: AtomicUsize,
  heap: UnsafeCell<[u8; HEAP_SIZE]>,
}
// SAFETY: single-threaded guest; bump is monotonic.
unsafe impl Sync for Bump {}

#[global_allocator]
static ALLOC: Bump = Bump {
  head: AtomicUsize::new(0),
  heap: UnsafeCell::new([0u8; HEAP_SIZE]),
};

unsafe impl GlobalAlloc for Bump {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let size = layout.size();
    let align = layout.align();
    let heap_start = self.heap.get() as *mut u8;
    loop {
      let current = self.head.load(Ordering::Relaxed);
      let aligned = (current + align - 1) & !(align - 1);
      let next = aligned + size;
      if next > HEAP_SIZE {
        #[cfg(target_arch = "wasm32")]
        core::arch::wasm32::unreachable();
        #[cfg(not(target_arch = "wasm32"))]
        return core::ptr::null_mut();
      }
      if self
        .head
        .compare_exchange(current, next, Ordering::SeqCst, Ordering::Relaxed)
        .is_ok()
      {
        return heap_start.add(aligned);
      }
    }
  }

  unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
  loop {
    core::hint::spin_loop();
  }
}

export!(Component with_types_in self);
