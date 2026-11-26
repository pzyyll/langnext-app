//! DirectWrite: the system font collection's family names.

use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection,
    IDWriteFontFamily, IDWriteLocalizedStrings,
};
use windows::core::{BOOL, w};

/// Every family the system font collection has, in its English name.
pub(super) fn families() -> Vec<String> {
    // SAFETY: DirectWrite needs no COM apartment for its factory, and every call below is a
    // plain query whose HRESULT is checked.
    let collection = unsafe {
        let factory = match DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) {
            Ok(factory) => factory,
            Err(error) => {
                log::warn!("DirectWrite has no factory: {error}");
                return Vec::new();
            }
        };
        let mut collection: Option<IDWriteFontCollection> = None;
        if let Err(error) = factory.GetSystemFontCollection(&mut collection, false) {
            log::warn!("DirectWrite has no system font collection: {error}");
            return Vec::new();
        }
        match collection {
            Some(collection) => collection,
            None => {
                log::warn!("DirectWrite returned no system font collection.");
                return Vec::new();
            }
        }
    };

    let mut names = Vec::new();
    // SAFETY: the index stays below the collection's own count.
    let count = unsafe { collection.GetFontFamilyCount() };
    for index in 0..count {
        // SAFETY: `index` is below `count`.
        let family = match unsafe { collection.GetFontFamily(index) } {
            Ok(family) => family,
            Err(error) => {
                log::debug!("DirectWrite skipped font family {index}: {error}");
                continue;
            }
        };
        if let Some(name) = family_name(&family) {
            names.push(name);
        }
    }
    names.sort();
    names.dedup();
    names
}

/// The family's English name, else its first name.
fn family_name(family: &IDWriteFontFamily) -> Option<String> {
    // SAFETY: a plain query with a local out value.
    let names: IDWriteLocalizedStrings = unsafe { family.GetFamilyNames() }.ok()?;
    let mut index = 0_u32;
    let mut english = BOOL(0);
    // SAFETY: the strings object outlives both out values.
    let found = unsafe { names.FindLocaleName(w!("en-us"), &mut index, &mut english) }.is_ok();
    let index = if found && english.as_bool() { index } else { 0 };
    // SAFETY: `index` names one of the collection's strings.
    let length = unsafe { names.GetStringLength(index) }.ok()?;
    let mut buffer = vec![0_u16; length as usize + 1];
    // SAFETY: the buffer holds the length and its terminator.
    unsafe { names.GetString(index, &mut buffer) }.ok()?;
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end])).filter(|name: &String| !name.is_empty())
}
