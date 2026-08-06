// ABOUTME: Conformance native worker fixture for handshake, OCR, hang, and crash modes.
// ABOUTME: Selected by LANGNEXT_NATIVE_CONFORMANCE_MODE; not a production PaddleOCR worker.
use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

const MAGIC: u32 = 0x4C4E_5750;
const KIND_HANDSHAKE: u16 = 1;
const KIND_READY: u16 = 2;
const KIND_OCR_REQ: u16 = 3;
const KIND_OCR_RESP: u16 = 4;

fn read_exact(buf: &mut [u8]) -> bool {
  std::io::stdin().read_exact(buf).is_ok()
}

fn write_frame(kind: u16, payload: &[u8]) {
  let mut out = Vec::with_capacity(10 + payload.len());
  out.extend_from_slice(&MAGIC.to_be_bytes());
  out.extend_from_slice(&kind.to_be_bytes());
  out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
  out.extend_from_slice(payload);
  let _ = std::io::stdout().write_all(&out);
  let _ = std::io::stdout().flush();
}

fn read_frame() -> Option<(u16, Vec<u8>)> {
  let mut header = [0u8; 10];
  if !read_exact(&mut header) {
    return None;
  }
  let magic = u32::from_be_bytes(header[0..4].try_into().ok()?);
  if magic != MAGIC {
    return None;
  }
  let kind = u16::from_be_bytes(header[4..6].try_into().ok()?);
  let len = u32::from_be_bytes(header[6..10].try_into().ok()?) as usize;
  let mut payload = vec![0u8; len];
  if len > 0 && !read_exact(&mut payload) {
    return None;
  }
  Some((kind, payload))
}

fn main() {
  let mode = std::env::var("LANGNEXT_NATIVE_CONFORMANCE_MODE").unwrap_or_else(|_| "success".into());
  match mode.as_str() {
    "hang" => loop {
      thread::sleep(Duration::from_secs(60));
    },
    "crash" => {
      // Fail before handshake.
      std::process::exit(99);
    }
    _ => {}
  }

  let (kind, payload) = match read_frame() {
    Some(v) => v,
    None => std::process::exit(2),
  };
  if kind != KIND_HANDSHAKE {
    std::process::exit(3);
  }
  write_frame(KIND_READY, &payload);

  let (kind, payload) = match read_frame() {
    Some(v) => v,
    None => std::process::exit(4),
  };
  if kind != KIND_OCR_REQ {
    std::process::exit(5);
  }
  let body = String::from_utf8_lossy(&payload);
  let rid = body
    .split("\"requestId\":\"")
    .nth(1)
    .and_then(|s| s.split('"').next())
    .unwrap_or("r");
  let resp = format!(r#"{{"requestId":"{rid}","text":"conformance-ok"}}"#);
  write_frame(KIND_OCR_RESP, resp.as_bytes());
  let _ = read_frame();
}
