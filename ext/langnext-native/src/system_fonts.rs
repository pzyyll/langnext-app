//! The font families this system has installed.
//!
//! The app's font setting offers the system's own families beside the fonts it ships;
//! NSH names an installed family in `fontFamily` directly, so the app needs only the names.

use nsh_core::prelude::*;

#[cfg(windows)]
mod windows;

/// The fonts the system has installed, for the app's font setting.
#[module]
pub struct SystemFontsNative;

#[module]
impl SystemFontsNative {
    /// The family names of every font this system has installed, sorted, without duplicates.
    ///
    /// # Rust
    ///
    /// Each name is a `fontFamily` value that resolves to an installed family: the names come
    /// from the platform's own font collection, so they are the names text layout looks up.
    /// Empty where the platform cannot list its fonts.
    pub fn system_font_families() -> Vec<String> {
        families()
    }
}

#[cfg(windows)]
use windows::families;

/// Off Windows the app lists no system fonts.
#[cfg(not(windows))]
fn families() -> Vec<String> {
    Vec::new()
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn lists_sorted_unique_family_names() {
        let families = super::families();
        assert!(!families.is_empty(), "the system lists no fonts");
        for pair in families.windows(2) {
            assert!(
                pair[0] < pair[1],
                "{} and {} are not sorted and unique",
                pair[0],
                pair[1]
            );
        }
        for family in &families {
            assert!(!family.is_empty() && family.trim() == family);
        }
    }
}
