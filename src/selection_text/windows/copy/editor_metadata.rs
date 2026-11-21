use std::mem::size_of;

use windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows_sys::core::w;

use super::utf16_units;

const EDITOR_DATA_TYPE: &str = "vscode-editor-data";

pub(super) fn format() -> u32 {
    // SAFETY: the name is a static NUL-terminated string. Registration does not change clipboard contents.
    unsafe { RegisterClipboardFormatW(w!("Chromium Web Custom MIME Data Format")) }
}

pub(super) fn has_selection(data: &[u8]) -> bool {
    editor_selection(data) == Some(true)
}

fn editor_selection(mut data: &[u8]) -> Option<bool> {
    // Chromium stores custom MIME data as a Pickle: payload size, entry count, then padded UTF-16 pairs.
    let payload_len = take_u32(&mut data)?;
    let mut payload = data.get(..payload_len)?;
    let entries = take_u32(&mut payload)?;
    for _ in 0..entries {
        let mime = take_utf16(&mut payload)?;
        let value = take_utf16(&mut payload)?;
        if !utf16_units(mime).eq(EDITOR_DATA_TYPE.encode_utf16()) {
            continue;
        }
        let json = char::decode_utf16(utf16_units(value))
            .collect::<Result<String, _>>()
            .ok()?;
        let metadata: serde_json::Value = serde_json::from_str(&json).ok()?;
        return metadata
            .get("isFromEmptySelection")?
            .as_bool()
            .map(|empty| !empty);
    }
    None
}

fn take_u32(data: &mut &[u8]) -> Option<usize> {
    let (head, rest) = data.split_first_chunk::<4>()?;
    *data = rest;
    Some(u32::from_le_bytes(*head) as usize)
}

fn take_utf16<'a>(data: &mut &'a [u8]) -> Option<&'a [[u8; 2]]> {
    let len = take_u32(data)?.checked_mul(size_of::<u16>())?;
    let (padded, rest) = data.split_at_checked(len.checked_next_multiple_of(size_of::<u32>())?)?;
    *data = rest;
    Some(padded[..len].as_chunks::<2>().0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pickle(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut payload = (entries.len() as u32).to_le_bytes().to_vec();
        for &(mime, value) in entries {
            for field in [mime, value] {
                payload.extend((field.encode_utf16().count() as u32).to_le_bytes());
                payload.extend(field.encode_utf16().flat_map(u16::to_le_bytes));
                payload.resize(payload.len().next_multiple_of(4), 0);
            }
        }
        [(payload.len() as u32).to_le_bytes().as_slice(), &payload].concat()
    }

    #[test]
    fn accepts_editor_selection_not_line_copy() {
        let clipboard =
            |metadata| pickle(&[("unrelated", "payload"), (EDITOR_DATA_TYPE, metadata)]);
        assert!(has_selection(&clipboard(
            r#"{"isFromEmptySelection":false}"#
        )));
        assert!(!has_selection(&clipboard(
            r#"{"isFromEmptySelection":true}"#
        )));
        assert!(!has_selection(&clipboard(
            r#"{"isFromEmptySelection":"false"}"#
        )));
        assert!(!has_selection(&pickle(&[(
            "other",
            r#"{"isFromEmptySelection":false}"#
        )])));
    }

    #[test]
    fn rejects_truncated_metadata() {
        let data = pickle(&[(EDITOR_DATA_TYPE, r#"{"isFromEmptySelection":false}"#)]);
        for len in 0..data.len() {
            assert!(!has_selection(&data[..len]));
        }
    }
}
