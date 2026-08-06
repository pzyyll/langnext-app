// ABOUTME: Bounded length-prefixed framed protocol codec for native workers.
// ABOUTME: Fixed magic/version headers; rejects oversized, partial, and unknown frames.
use crate::domain::native_worker::{NATIVE_FRAME_MAGIC, NATIVE_FRAME_MAX_PAYLOAD_BYTES, NativeFrameKind};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::{Read, Write};

/// Length-prefixed frame header: magic(u32 BE) + kind(u16 BE) + payload_len(u32 BE).
pub const NATIVE_FRAME_HEADER_LEN: usize = 4 + 2 + 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFrame {
  pub kind: NativeFrameKind,
  pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
  Io(String),
  BadMagic(u32),
  UnknownKind(u16),
  Oversized(u32),
  Partial,
  Codec(String),
}

impl std::fmt::Display for ProtocolError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Io(msg) => write!(f, "io: {msg}"),
      Self::BadMagic(magic) => write!(f, "bad magic {magic:#x}"),
      Self::UnknownKind(kind) => write!(f, "unknown frame kind {kind}"),
      Self::Oversized(len) => write!(f, "oversized frame payload {len}"),
      Self::Partial => write!(f, "partial frame"),
      Self::Codec(msg) => write!(f, "codec: {msg}"),
    }
  }
}

impl std::error::Error for ProtocolError {}

pub fn encode_frame(kind: NativeFrameKind, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
  if payload.len() as u64 > NATIVE_FRAME_MAX_PAYLOAD_BYTES {
    return Err(ProtocolError::Oversized(payload.len() as u32));
  }
  let mut out = Vec::with_capacity(NATIVE_FRAME_HEADER_LEN + payload.len());
  out.extend_from_slice(&NATIVE_FRAME_MAGIC.to_be_bytes());
  out.extend_from_slice(&kind.as_u16().to_be_bytes());
  out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
  out.extend_from_slice(payload);
  Ok(out)
}

pub fn encode_json_frame<T: Serialize>(kind: NativeFrameKind, value: &T) -> Result<Vec<u8>, ProtocolError> {
  let payload = serde_json::to_vec(value).map_err(|err| ProtocolError::Codec(err.to_string()))?;
  encode_frame(kind, &payload)
}

pub fn write_frame<W: Write>(writer: &mut W, kind: NativeFrameKind, payload: &[u8]) -> Result<(), ProtocolError> {
  let bytes = encode_frame(kind, payload)?;
  writer
    .write_all(&bytes)
    .map_err(|err| ProtocolError::Io(err.to_string()))?;
  writer.flush().map_err(|err| ProtocolError::Io(err.to_string()))
}

pub fn write_json_frame<W: Write, T: Serialize>(
  writer: &mut W,
  kind: NativeFrameKind,
  value: &T,
) -> Result<(), ProtocolError> {
  let bytes = encode_json_frame(kind, value)?;
  writer
    .write_all(&bytes)
    .map_err(|err| ProtocolError::Io(err.to_string()))?;
  writer.flush().map_err(|err| ProtocolError::Io(err.to_string()))
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<NativeFrame, ProtocolError> {
  let mut header = [0u8; NATIVE_FRAME_HEADER_LEN];
  match reader.read_exact(&mut header) {
    Ok(()) => {}
    Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Err(ProtocolError::Partial),
    Err(err) => return Err(ProtocolError::Io(err.to_string())),
  }
  let magic = u32::from_be_bytes(header[0..4].try_into().unwrap());
  if magic != NATIVE_FRAME_MAGIC {
    return Err(ProtocolError::BadMagic(magic));
  }
  let kind_raw = u16::from_be_bytes(header[4..6].try_into().unwrap());
  let kind = NativeFrameKind::from_u16(kind_raw).ok_or(ProtocolError::UnknownKind(kind_raw))?;
  let len = u32::from_be_bytes(header[6..10].try_into().unwrap());
  if len as u64 > NATIVE_FRAME_MAX_PAYLOAD_BYTES {
    return Err(ProtocolError::Oversized(len));
  }
  let mut payload = vec![0u8; len as usize];
  if len > 0 {
    match reader.read_exact(&mut payload) {
      Ok(()) => {}
      Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Err(ProtocolError::Partial),
      Err(err) => return Err(ProtocolError::Io(err.to_string())),
    }
  }
  Ok(NativeFrame { kind, payload })
}

pub fn decode_json_payload<T: DeserializeOwned>(frame: &NativeFrame) -> Result<T, ProtocolError> {
  serde_json::from_slice(&frame.payload).map_err(|err| ProtocolError::Codec(err.to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::native_worker::NativeHandshakeRequest;
  use std::io::Cursor;

  #[test]
  fn protocol_round_trips_json_frame() {
    let req = NativeHandshakeRequest {
      protocol_version: 1,
      package_digest: "a".repeat(64),
      runtime_set_digest: "b".repeat(64),
      model_set_digest: "c".repeat(64),
      process_nonce: "nonce".into(),
      model_api_version: 1,
    };
    let bytes = encode_json_frame(NativeFrameKind::Handshake, &req).unwrap();
    let mut cursor = Cursor::new(bytes);
    let frame = read_frame(&mut cursor).unwrap();
    assert_eq!(frame.kind, NativeFrameKind::Handshake);
    let decoded: NativeHandshakeRequest = decode_json_payload(&frame).unwrap();
    assert_eq!(decoded, req);
  }

  #[test]
  fn protocol_rejects_bad_magic() {
    let mut bad = vec![0u8; NATIVE_FRAME_HEADER_LEN];
    bad[0..4].copy_from_slice(&0xdead_beefu32.to_be_bytes());
    let err = read_frame(&mut Cursor::new(bad)).unwrap_err();
    assert!(matches!(err, ProtocolError::BadMagic(_)));
  }
}
