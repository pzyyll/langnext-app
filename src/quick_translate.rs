//! Native Quick Translate helpers for cursor monitor lookup on Windows.

use nsh_core::prelude::*;

/// Physical cursor location relative to the containing monitor's desktop rectangle.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct CursorAnchor {
    /// Stable NSH display identifier formatted identically to `displays()[i].id`.
    pub display_id: nsh_core::desktop::DisplayId,
    /// Horizontal cursor offset in physical pixels from `rcMonitor.left`.
    pub offset_x: f64,
    /// Vertical cursor offset in physical pixels from `rcMonitor.top`.
    pub offset_y: f64,
}

/// Native platform functions backing the Quick Translate floating window.
#[module]
pub struct QuickTranslateNative;

#[module]
impl QuickTranslateNative {
    /// Returns the cursor's monitor ID and physical offset from that monitor's origin, or null outside Windows.
    ///
    /// # Rust
    ///
    /// Matches NSH 0.6.0's Windows screen enumeration (`EnumDisplayDevicesW` interface name,
    /// falling back to `szDevice`) so `DisplayId::from_name` aligns on mixed-DPI setups.
    pub fn cursor_anchor() -> Option<CursorAnchor> {
        platform_cursor_anchor()
    }
}

#[cfg(windows)]
fn utf16_z_to_string(units: &[u16]) -> String {
    let end = units.iter().position(|c| *c == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

#[cfg(windows)]
fn resolve_monitor_key(device_id: &[u16], sz_device: &[u16]) -> String {
    if device_id.first().copied().unwrap_or(0) != 0 {
        utf16_z_to_string(device_id)
    } else {
        utf16_z_to_string(sz_device)
    }
}

#[cfg(windows)]
fn platform_cursor_anchor() -> Option<CursorAnchor> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        DISPLAY_DEVICEW, EnumDisplayDevicesW, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST,
        MONITORINFO, MONITORINFOEXW, MonitorFromPoint,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: `point` is a stack-allocated Win32 POINT out-parameter.
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return None;
    }

    // SAFETY: `point` is initialized by `GetCursorPos`.
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }

    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: `info` has `cbSize` set to `size_of::<MONITORINFOEXW>()`, matching the Win32 contract.
    if unsafe {
        GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
    } == 0
    {
        return None;
    }

    let native = info.monitorInfo.rcMonitor;
    if native.right <= native.left || native.bottom <= native.top {
        return None;
    }

    let mut device: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
    device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
    // SAFETY: `info.szDevice` is NUL-terminated; `device.cb` matches `size_of::<DISPLAY_DEVICEW>()`.
    let has_interface = unsafe {
        EnumDisplayDevicesW(
            info.szDevice.as_ptr(),
            0,
            &mut device,
            EDD_GET_DEVICE_INTERFACE_NAME,
        )
    } != 0;

    let stable_name = if has_interface {
        resolve_monitor_key(&device.DeviceID, &info.szDevice)
    } else {
        utf16_z_to_string(&info.szDevice)
    };

    Some(CursorAnchor {
        display_id: nsh_core::desktop::DisplayId::from_name(stable_name.as_bytes()),
        offset_x: f64::from(point.x - native.left),
        offset_y: f64::from(point.y - native.top),
    })
}

#[cfg(not(windows))]
fn platform_cursor_anchor() -> Option<CursorAnchor> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resolves_interface_name_over_gdi_device_name() {
        let iface: Vec<u16> = "\\\\?\\DISPLAY#DEL1234#0\0".encode_utf16().collect();
        let gdi: Vec<u16> = "\\\\.\\DISPLAY1\0".encode_utf16().collect();
        assert_eq!(
            resolve_monitor_key(&iface, &gdi),
            "\\\\?\\DISPLAY#DEL1234#0"
        );
        assert_eq!(resolve_monitor_key(&[0], &gdi), "\\\\.\\DISPLAY1");
    }

    #[cfg(windows)]
    #[test]
    fn windows_cursor_anchor_returns_valid_display_id_or_headless_none() {
        if let Some(anchor) = platform_cursor_anchor() {
            assert_ne!(anchor.display_id.0, 0);
            assert!(anchor.offset_x.is_finite());
            assert!(anchor.offset_y.is_finite());
        }
    }
}
