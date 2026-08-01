// ABOUTME: Test-only OCR Component that returns text beyond the host response bound.
// ABOUTME: Used to prove invalid-response mapping and input Blob cleanup without fallback.
#![no_std]

extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;

wit_bindgen::generate!({
  path: "../../../src-tauri/wit/runtime-plugin",
  world: "ocr-image-world",
  std_feature,
});

use exports::langnext::runtime_plugin::ocr_image::{Guest, ImageRequest, ImageResponse};
use langnext::runtime_plugin::common::PluginError;

const OVERSIZED_TEXT_BYTES: usize = 1024 * 1024;
struct Component;

impl Guest for Component {
  fn image(_config: Vec<u8>, _request: ImageRequest) -> Result<ImageResponse, PluginError> {
    Ok(ImageResponse {
      text: String::from("x").repeat(OVERSIZED_TEXT_BYTES),
    })
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
    let size = layout.size();
    let align = layout.align();
    let current = self.head.load(Ordering::Relaxed);
    let aligned = (current + align - 1) & !(align - 1);
    let next = aligned + size;
    if next > HEAP_SIZE {
      core::arch::wasm32::unreachable()
    }
    self.head.store(next, Ordering::Relaxed);
    self.heap.get().cast::<u8>().add(aligned)
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
