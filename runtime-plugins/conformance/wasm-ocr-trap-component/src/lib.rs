// ABOUTME: Test-only OCR Component that traps after receiving an input BlobHandle.
// ABOUTME: Used to prove host trap mapping, request cleanup, and rollback preservation.
#![no_std]

extern crate alloc;
use alloc::vec::Vec;

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "ocr-image-world",
  std_feature,
});

use exports::langnext::runtime_plugin::ocr_image::{Guest, ImageRequest, ImageResponse};
use langnext::runtime_plugin::common::PluginError;

struct Component;

impl Guest for Component {
  fn image(_config: Vec<u8>, _request: ImageRequest) -> Result<ImageResponse, PluginError> {
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    unreachable!("conformance OCR trap");
  }
}

use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicUsize, Ordering};

const HEAP_SIZE: usize = 4 * 1024 * 1024;
struct Bump {
  head: AtomicUsize,
  heap: UnsafeCell<[u8; HEAP_SIZE]>,
}
unsafe impl Sync for Bump {}
#[global_allocator]
static ALLOC: Bump = Bump {
  head: AtomicUsize::new(0),
  heap: UnsafeCell::new([0; HEAP_SIZE]),
};
unsafe impl GlobalAlloc for Bump {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let current = self.head.fetch_add(
      (layout.size() + layout.align() - 1) & !(layout.align() - 1),
      Ordering::Relaxed,
    );
    if current + layout.size() > HEAP_SIZE {
      core::arch::wasm32::unreachable()
    }
    self.heap.get().cast::<u8>().add(current)
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
