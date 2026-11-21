//! Windows selection reader. UI Automation runs on a worker, never on the engine thread.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation2, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTreeWalker, SupportedTextSelection_None, TextPatternRangeEndpoint_End,
    TextPatternRangeEndpoint_Start, UIA_E_NOTSUPPORTED, UIA_TextPatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GA_ROOT, GUITHREADINFO, GetAncestor, GetForegroundWindow, GetGUIThreadInfo,
    GetWindowThreadProcessId,
};
use windows::core::Error;

use super::{SelectionTextResult, SelectionTextStatus};

mod copy;

/// Milliseconds UI Automation may wait for one provider connection.
const CONNECTION_TIMEOUT_MS: u32 = 250;

/// Milliseconds UI Automation may wait for one cross-process transaction.
const TRANSACTION_TIMEOUT_MS: u32 = 250;

/// Time spent between UI Automation calls before the read is given up.
/// An in-flight call cannot be interrupted when this budget ends.
const READ_BUDGET: Duration = Duration::from_millis(750);

/// Chromium can expose more than 20 non-window nodes below the first native handle.
const MAX_ANCESTORS: usize = 32;
const EDIT_CONTEXT_CLASS: &str = "native-edit-context";
const MONACO_EDITOR_CLASS: &str = "monaco-editor";

/// `E_NOINTERFACE`: the element has no TextPattern.
const E_NOINTERFACE: u32 = 0x8000_4002;

/// `E_NOTIMPL`: the provider does not implement TextPattern.
const E_NOTIMPL: u32 = 0x8000_4001;

const TARGET_VERSION: &str = "v1";

enum ApartmentError {
    WrongMode,
    Failed,
}

enum ReadFailure {
    Unavailable,
}

enum CandidateText {
    Unsupported,
    Empty,
    Text(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FocusKind {
    Standard,
    MonacoEditContext,
}

impl FocusKind {
    fn can_copy_empty_range(self, level: usize) -> bool {
        matches!(self, Self::MonacoEditContext) && level == 0
    }
}

/// Keeps this thread in the multithreaded apartment until COM objects from the read are gone.
struct ComApartment;

impl ComApartment {
    fn enter() -> Result<Self, ApartmentError> {
        // SAFETY: this worker has not created COM objects yet. `Drop` releases the apartment
        // only after those objects have been dropped by the caller.
        let started = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if started == RPC_E_CHANGED_MODE {
            return Err(ApartmentError::WrongMode);
        }
        if started.is_ok() {
            Ok(Self)
        } else {
            Err(ApartmentError::Failed)
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: every interface created while this guard was alive has already been dropped.
        unsafe { CoUninitialize() };
    }
}

/// Opaque ids of the foreground window and its focused control, or `None` when nothing is in front.
pub(crate) fn snapshot() -> Option<String> {
    // SAFETY: both calls read process-wide window state and do not retain the returned handles.
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
        return None;
    }
    let thread_id = unsafe { GetWindowThreadProcessId(foreground, None) };
    if thread_id == 0 {
        return Some(encode_target(foreground, HWND::default()));
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..GUITHREADINFO::default()
    };
    // SAFETY: `info.cbSize` is set, and the pointer stays valid for the call.
    let focus = unsafe { GetGUIThreadInfo(thread_id, &mut info) }
        .ok()
        .map(|_| info.hwndFocus)
        .unwrap_or_default();
    Some(encode_target(foreground, focus))
}

/// Whether `target` still matches a fresh foreground snapshot.
pub(crate) fn is_current(target: &str) -> bool {
    snapshot().as_deref() == Some(target)
}

/// Reads `target` if it is still the foreground focus.
pub(crate) fn read_target(target: &str, allow_copy_fallback: bool) -> SelectionTextResult {
    if !is_current(target) {
        return SelectionTextResult::stale();
    }
    let Some((foreground, focus)) = decode_target(target) else {
        return SelectionTextResult::stale();
    };
    if focus.is_invalid() {
        return keep_current(target, SelectionTextResult::unavailable());
    }

    let _apartment = match ComApartment::enter() {
        Ok(apartment) => apartment,
        Err(_) => return keep_current(target, SelectionTextResult::unavailable()),
    };
    let started = Instant::now();
    let result = match read_focused_selection(target, foreground, started, allow_copy_fallback) {
        Ok(result) => result,
        Err(ReadFailure::Unavailable) => SelectionTextResult::unavailable(),
    };
    keep_current(target, result)
}

fn keep_current(target: &str, result: SelectionTextResult) -> SelectionTextResult {
    if result.status == SelectionTextStatus::Stale || is_current(target) {
        result
    } else {
        SelectionTextResult::stale()
    }
}

fn read_focused_selection(
    target: &str,
    foreground: HWND,
    started: Instant,
    allow_copy_fallback: bool,
) -> Result<SelectionTextResult, ReadFailure> {
    ensure_budget(started)?;
    // SAFETY: `CUIAutomation8` is the in-process UI Automation class, created on this MTA worker.
    let automation: IUIAutomation2 = unsafe {
        CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| ReadFailure::Unavailable)?
    };
    // SAFETY: these setters only change this client's timeouts and focus behavior.
    unsafe {
        automation
            .SetConnectionTimeout(CONNECTION_TIMEOUT_MS)
            .map_err(|_| ReadFailure::Unavailable)?;
        automation
            .SetTransactionTimeout(TRANSACTION_TIMEOUT_MS)
            .map_err(|_| ReadFailure::Unavailable)?;
        // A selection read must not move the user's focus to another control.
        automation
            .SetAutoSetFocus(false)
            .map_err(|_| ReadFailure::Unavailable)?;
    }
    ensure_budget(started)?;
    // SAFETY: `GetFocusedElement` and `RawViewWalker` borrow this automation client.
    let focused =
        unsafe { automation.GetFocusedElement() }.map_err(|_| ReadFailure::Unavailable)?;
    // A protected focused control ends the read before any ancestor is considered.
    if is_protected(&focused)? {
        return Ok(SelectionTextResult::unavailable());
    }
    let walker = unsafe { automation.RawViewWalker() }.map_err(|_| ReadFailure::Unavailable)?;
    let Some(kind) = foreground_focus_kind(
        &automation,
        &walker,
        &focused,
        foreground,
        started,
        allow_copy_fallback,
    )?
    else {
        return Ok(SelectionTextResult::unavailable());
    };
    let try_copy = || {
        ensure_budget(started)?;
        copy::read(
            target,
            foreground,
            kind == FocusKind::MonacoEditContext,
            || Ok(focus_matches(&automation, &focused)? && !is_protected(&focused)?),
        )
    };

    let mut candidate = clone_element(&focused)?;
    for level in 0..=MAX_ANCESTORS {
        ensure_budget(started)?;
        if level > 0 {
            let Some(parent) = parent_element(&automation, &walker, &candidate, started)? else {
                break;
            };
            candidate = parent;
        }
        if above_foreground(&candidate, foreground)? {
            break;
        }
        if is_protected(&candidate)? {
            return Ok(SelectionTextResult::unavailable());
        }
        match selection_text(&candidate, started)? {
            CandidateText::Unsupported => {}
            // Monaco's hidden input has its own range, which does not represent the editor selection.
            CandidateText::Empty if kind.can_copy_empty_range(level) => return try_copy(),
            CandidateText::Empty => {
                return confirm_focus(
                    &automation,
                    &focused,
                    started,
                    SelectionTextResult::no_selection(),
                );
            }
            CandidateText::Text(text) => {
                return confirm_focus(
                    &automation,
                    &focused,
                    started,
                    SelectionTextResult::selected(text),
                );
            }
        }
        if at_foreground_root(&candidate, foreground)? {
            if allow_copy_fallback {
                return try_copy();
            }
            break;
        }
    }
    Ok(SelectionTextResult::unavailable())
}

fn foreground_focus_kind(
    automation: &IUIAutomation2,
    walker: &IUIAutomationTreeWalker,
    start: &IUIAutomationElement,
    foreground: HWND,
    started: Instant,
    allow_copy_fallback: bool,
) -> Result<Option<FocusKind>, ReadFailure> {
    let identify_editor = allow_copy_fallback && has_class(start, EDIT_CONTEXT_CLASS);
    let mut kind = FocusKind::Standard;
    let mut current = start.clone();
    for level in 0..=MAX_ANCESTORS {
        ensure_budget(started)?;
        if identify_editor
            && matches!(kind, FocusKind::Standard)
            && level > 0
            && has_class(&current, MONACO_EDITOR_CLASS)
        {
            kind = FocusKind::MonacoEditContext;
        }
        if let Some(hwnd) = native_hwnd(&current)? {
            return Ok((window_root(hwnd) == foreground).then_some(kind));
        }
        if level == MAX_ANCESTORS {
            break;
        }
        let Some(parent) = parent_element(automation, walker, &current, started)? else {
            break;
        };
        current = parent;
    }
    Ok(None)
}

fn has_class(element: &IUIAutomationElement, name: &str) -> bool {
    // SAFETY: reads only the class of this UI Automation element.
    unsafe { element.CurrentClassName() }.is_ok_and(|classes| {
        classes
            .to_string()
            .split_ascii_whitespace()
            .any(|class| class == name)
    })
}

fn confirm_focus(
    automation: &IUIAutomation2,
    initial: &IUIAutomationElement,
    started: Instant,
    result: SelectionTextResult,
) -> Result<SelectionTextResult, ReadFailure> {
    ensure_budget(started)?;
    if focus_matches(automation, initial)? {
        Ok(result)
    } else {
        Ok(SelectionTextResult::stale())
    }
}

fn focus_matches(
    automation: &IUIAutomation2,
    initial: &IUIAutomationElement,
) -> Result<bool, ReadFailure> {
    // SAFETY: both elements come from this same automation client.
    let current =
        unsafe { automation.GetFocusedElement() }.map_err(|_| ReadFailure::Unavailable)?;
    let same = unsafe { automation.CompareElements(initial, &current) }
        .map_err(|_| ReadFailure::Unavailable)?;
    Ok(same.as_bool())
}

fn selection_text(
    element: &IUIAutomationElement,
    started: Instant,
) -> Result<CandidateText, ReadFailure> {
    ensure_budget(started)?;
    // SAFETY: asks this element for its current TextPattern, if it has one.
    let pattern =
        match unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
        {
            Ok(pattern) => pattern,
            Err(error) if pattern_is_missing(&error) => return Ok(CandidateText::Unsupported),
            Err(_) => return Err(ReadFailure::Unavailable),
        };
    ensure_budget(started)?;
    // SAFETY: `GetSelection` returns only the selected ranges, never the whole document.
    let ranges = match unsafe { pattern.GetSelection() } {
        Ok(ranges) => ranges,
        Err(error) if pattern_is_missing(&error) => {
            return if lacks_text_selection(&pattern, started)? {
                Ok(CandidateText::Unsupported)
            } else {
                Err(ReadFailure::Unavailable)
            };
        }
        Err(_) => return Err(ReadFailure::Unavailable),
    };
    let length = unsafe { ranges.Length() }.map_err(|_| ReadFailure::Unavailable)?;
    if length <= 0 {
        return if lacks_text_selection(&pattern, started)? {
            Ok(CandidateText::Unsupported)
        } else {
            Ok(CandidateText::Empty)
        };
    }

    let mut parts = Vec::new();
    for index in 0..length {
        ensure_budget(started)?;
        // SAFETY: `index` is inside the range array returned above.
        let range = unsafe { ranges.GetElement(index) }.map_err(|_| ReadFailure::Unavailable)?;
        let collapsed = unsafe {
            range.CompareEndpoints(
                TextPatternRangeEndpoint_Start,
                &range,
                TextPatternRangeEndpoint_End,
            )
        }
        .map_err(|_| ReadFailure::Unavailable)?;
        if collapsed == 0 {
            continue;
        }
        // SAFETY: `-1` asks the provider for the whole range. Failure discards every part.
        let raw = unsafe { range.GetText(-1) }.map_err(|_| ReadFailure::Unavailable)?;
        let text = String::from_utf16(&raw).map_err(|_| ReadFailure::Unavailable)?;
        if !text.is_empty() {
            parts.push(text);
        }
    }

    let text = parts.join("\n");
    if text.chars().all(char::is_whitespace) {
        Ok(CandidateText::Empty)
    } else {
        Ok(CandidateText::Text(text))
    }
}

fn lacks_text_selection(
    pattern: &IUIAutomationTextPattern,
    started: Instant,
) -> Result<bool, ReadFailure> {
    ensure_budget(started)?;
    // SAFETY: queries the selection capabilities of this text pattern.
    unsafe { pattern.SupportedTextSelection() }
        .map(|support| support == SupportedTextSelection_None)
        .map_err(|_| ReadFailure::Unavailable)
}

fn is_protected(element: &IUIAutomationElement) -> Result<bool, ReadFailure> {
    // SAFETY: reads the password flag and does not retrieve the control's text.
    match unsafe { element.CurrentIsPassword() } {
        Ok(value) => Ok(value.as_bool()),
        Err(_) => Err(ReadFailure::Unavailable),
    }
}

fn parent_element(
    automation: &IUIAutomation2,
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    started: Instant,
) -> Result<Option<IUIAutomationElement>, ReadFailure> {
    ensure_budget(started)?;
    // SAFETY: the raw walker returns the parent without crossing into another tree view.
    let parent = match unsafe { walker.GetParentElement(element) } {
        Ok(parent) => parent,
        Err(_) => return Ok(None),
    };
    let same = unsafe { automation.CompareElements(element, &parent) }
        .map_err(|_| ReadFailure::Unavailable)?;
    if same.as_bool() {
        Ok(None)
    } else {
        Ok(Some(parent))
    }
}

fn above_foreground(element: &IUIAutomationElement, foreground: HWND) -> Result<bool, ReadFailure> {
    Ok(match native_hwnd(element)? {
        Some(hwnd) => window_root(hwnd) != foreground,
        None => false,
    })
}

fn at_foreground_root(
    element: &IUIAutomationElement,
    foreground: HWND,
) -> Result<bool, ReadFailure> {
    Ok(native_hwnd(element)? == Some(foreground))
}

fn native_hwnd(element: &IUIAutomationElement) -> Result<Option<HWND>, ReadFailure> {
    // SAFETY: reads the native window id and does not use it after this check.
    let hwnd =
        unsafe { element.CurrentNativeWindowHandle() }.map_err(|_| ReadFailure::Unavailable)?;
    if hwnd.is_invalid() {
        Ok(None)
    } else {
        Ok(Some(hwnd))
    }
}

fn window_root(hwnd: HWND) -> HWND {
    // SAFETY: `GA_ROOT` only queries the ancestor of a window id already read from UI Automation.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_invalid() { hwnd } else { root }
}

fn clone_element(element: &IUIAutomationElement) -> Result<IUIAutomationElement, ReadFailure> {
    Ok(element.clone())
}

fn ensure_budget(started: Instant) -> Result<(), ReadFailure> {
    if started.elapsed() < READ_BUDGET {
        Ok(())
    } else {
        Err(ReadFailure::Unavailable)
    }
}

fn pattern_is_missing(error: &Error) -> bool {
    let code = error.code().0 as u32;
    // windows-rs returns an empty error when UI Automation leaves the interface null.
    error.code() == Error::empty().code()
        || code == UIA_E_NOTSUPPORTED
        || code == E_NOINTERFACE
        || code == E_NOTIMPL
}

fn encode_target(foreground: HWND, focus: HWND) -> String {
    format!(
        "{TARGET_VERSION}:{:x}:{:x}",
        foreground.0 as usize, focus.0 as usize
    )
}

fn decode_target(target: &str) -> Option<(HWND, HWND)> {
    let mut parts = target.split(':');
    if parts.next() != Some(TARGET_VERSION) {
        return None;
    }
    let foreground = usize::from_str_radix(parts.next()?, 16).ok()?;
    let focus = usize::from_str_radix(parts.next()?, 16).ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((hwnd_from_bits(foreground), hwnd_from_bits(focus)))
}

fn hwnd_from_bits(value: usize) -> HWND {
    HWND(value as *mut core::ffi::c_void)
}
