// ABOUTME: Shared UUIDv7 and RFC 3339 UTC timestamp helpers.
// ABOUTME: Repositories and services use these instead of hand-rolled formats.
use crate::error::StorageError;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

/// Generate a new UUIDv7 identifier for user-created entities.
pub fn new_id() -> Uuid {
  Uuid::now_v7()
}

/// Current UTC time as an RFC 3339 string.
pub fn now_rfc3339() -> String {
  OffsetDateTime::now_utc()
    .format(&Rfc3339)
    .expect("RFC 3339 formatting of UTC datetime always succeeds")
}

/// Compact UTC timestamp for filenames (no colons): YYYYMMDDTHHMMSSZ.
pub fn now_filename_utc() -> String {
  let now = OffsetDateTime::now_utc();
  format!(
    "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
    now.year(),
    now.month() as u8,
    now.day(),
    now.hour(),
    now.minute(),
    now.second()
  )
}

/// Parse an RFC 3339 timestamp into UTC.
pub fn parse_rfc3339(value: &str) -> Result<OffsetDateTime, StorageError> {
  OffsetDateTime::parse(value, &Rfc3339)
    .map(|dt| dt.to_offset(UtcOffset::UTC))
    .map_err(|e| StorageError::Validation(format!("invalid timestamp: {e}")))
}

/// Format an OffsetDateTime as RFC 3339 UTC text.
pub fn format_rfc3339(dt: OffsetDateTime) -> Result<String, StorageError> {
  dt.to_offset(UtcOffset::UTC)
    .format(&Rfc3339)
    .map_err(|e| StorageError::Internal(format!("timestamp format failed: {e}")))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn uuid_v7_round_trip() {
    let id = new_id();
    assert_eq!(id.get_version(), Some(uuid::Version::SortRand));
  }

  #[test]
  fn rfc3339_round_trip() {
    let s = now_rfc3339();
    let parsed = parse_rfc3339(&s).expect("parse");
    let again = format_rfc3339(parsed).expect("format");
    assert_eq!(s, again);
  }

  #[test]
  fn filename_utc_has_no_colons() {
    let name = now_filename_utc();
    assert!(!name.contains(':'));
    assert!(name.ends_with('Z'));
  }
}
