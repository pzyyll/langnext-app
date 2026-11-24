use langnext::screen_capture::{CaptureCrop, DesktopPoint, MonitorRect, resolve_capture_rect};

/// 1920 × 1080 primary display at the virtual desktop origin.
const PRIMARY: MonitorRect = MonitorRect::new(0, 0, 1920, 1080);
/// Smaller display left of the primary, with a negative desktop origin.
const LEFT_DISPLAY: MonitorRect = MonitorRect::new(-1600, -200, 0, 900);

fn point(x: i32, y: i32) -> DesktopPoint {
    DesktopPoint { x, y }
}

#[test]
fn crops_a_reverse_drag_on_a_display_left_of_the_primary() {
    let monitors = [PRIMARY, LEFT_DISPLAY];

    let crop = resolve_capture_rect(&monitors, point(-400, 700), point(-1200, 100));

    assert_eq!(
        crop,
        Some(CaptureCrop {
            monitor: 1,
            x: 400,
            y: 300,
            width: 800,
            height: 600,
        })
    );
}

#[test]
fn clips_a_drag_that_leaves_the_starting_display() {
    let monitors = [PRIMARY, LEFT_DISPLAY];

    // Past the primary's right edge.
    assert_eq!(
        resolve_capture_rect(&monitors, point(1900, 100), point(2400, 400)),
        Some(CaptureCrop {
            monitor: 0,
            x: 1900,
            y: 100,
            width: 20,
            height: 300,
        })
    );

    // Past the primary's bottom edge, dragged upward.
    assert_eq!(
        resolve_capture_rect(&monitors, point(500, 1060), point(600, 1400)),
        Some(CaptureCrop {
            monitor: 0,
            x: 500,
            y: 1060,
            width: 100,
            height: 20,
        })
    );

    // From the left display across the primary's origin, stopping at its own edge.
    assert_eq!(
        resolve_capture_rect(&monitors, point(-300, 0), point(900, 200)),
        Some(CaptureCrop {
            monitor: 1,
            x: 1300,
            y: 200,
            width: 300,
            height: 200,
        })
    );

    // Above a display whose origin is negative.
    assert_eq!(
        resolve_capture_rect(&monitors, point(-100, -150), point(-900, -600)),
        Some(CaptureCrop {
            monitor: 1,
            x: 700,
            y: 0,
            width: 800,
            height: 50,
        })
    );
}

#[test]
fn a_zero_area_selection_produces_no_image() {
    let monitors = [PRIMARY, LEFT_DISPLAY];

    assert_eq!(
        resolve_capture_rect(&monitors, point(100, 100), point(100, 300)),
        None
    );
    assert_eq!(
        resolve_capture_rect(&monitors, point(100, 100), point(100, 100)),
        None
    );
    // A drag that starts on a display edge clips to nothing.
    assert_eq!(
        resolve_capture_rect(&monitors, point(1920, 10), point(2400, 200)),
        None
    );
}

#[test]
fn a_drag_starting_outside_every_display_produces_no_image() {
    let monitors = [PRIMARY];

    assert_eq!(
        resolve_capture_rect(&monitors, point(-50, 50), point(200, 400)),
        None
    );
}

#[test]
fn a_degenerate_display_never_yields_a_crop() {
    let monitors = [MonitorRect::new(0, 0, 0, 1080), PRIMARY];

    assert_eq!(
        resolve_capture_rect(&monitors, point(0, 10), point(300, 400)),
        Some(CaptureCrop {
            monitor: 1,
            x: 0,
            y: 10,
            width: 300,
            height: 390,
        })
    );
}
