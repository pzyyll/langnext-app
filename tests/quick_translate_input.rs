use std::cell::Cell;
use std::time::{Duration, Instant};

use langnext::quick_translate::{
    DoubleCopyDecision, DoubleCopyRecognizer, Modifiers, VK_C, settle_clipboard_copy,
};

const VK_CONTROL: u16 = 0x11;
const VK_LCONTROL: u16 = 0xA2;
const VK_RSHIFT: u16 = 0xA1;
const VK_LMENU: u16 = 0xA4;
const VK_RMENU: u16 = 0xA5;
const VK_LWIN: u16 = 0x5B;
const VK_V: u16 = 0x56;
const VK_A: u16 = 0x41;

fn trigger_decision(
    recognizer: &mut DoubleCopyRecognizer,
    vkey: u16,
    is_down: bool,
    at: Instant,
    seq: u32,
) -> Option<DoubleCopyDecision> {
    recognizer.handle_raw_key(vkey, is_down, at, seq)
}

#[test]
fn activates_once_for_two_distinct_ctrl_c_presses_under_400ms() {
    let base = Instant::now();
    let mut rec = DoubleCopyRecognizer::new();

    // Case 1: release Ctrl between presses.
    assert_eq!(
        trigger_decision(&mut rec, VK_LCONTROL, true, base, 10),
        None
    );
    assert_eq!(trigger_decision(&mut rec, VK_C, true, base, 10), None);
    assert_eq!(
        trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(40), 11),
        None
    );
    assert_eq!(
        trigger_decision(
            &mut rec,
            VK_LCONTROL,
            false,
            base + Duration::from_millis(60),
            11
        ),
        None
    );

    assert_eq!(
        trigger_decision(
            &mut rec,
            VK_LCONTROL,
            true,
            base + Duration::from_millis(240),
            11
        ),
        None
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(250), 11),
        Some(DoubleCopyDecision {
            seq_before_first: 10,
            seq_at_second: 11,
        })
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(280), 12),
        None
    );

    // A third Ctrl+C shortly after starts a new pair rather than activating again.
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(350), 12),
        None
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(370), 12),
        None
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(520), 12),
        Some(DoubleCopyDecision {
            seq_before_first: 12,
            seq_at_second: 12,
        })
    );
}

#[test]
fn does_not_activate_on_single_press_or_at_401ms() {
    let base = Instant::now();
    let mut rec = DoubleCopyRecognizer::new();

    assert_eq!(trigger_decision(&mut rec, VK_CONTROL, true, base, 1), None);
    assert_eq!(trigger_decision(&mut rec, VK_C, true, base, 1), None);
    assert_eq!(
        trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(50), 2),
        None
    );

    // 401 ms exceeds the double-copy window; becomes a fresh first press.
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(401), 2),
        None
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(440), 2),
        None
    );

    // Next press within 400 ms of the 401 ms press succeeds.
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(650), 3),
        Some(DoubleCopyDecision {
            seq_before_first: 2,
            seq_at_second: 3,
        })
    );
}

#[test]
fn rejects_c_hold_and_auto_repeat_without_release() {
    let base = Instant::now();
    let mut rec = DoubleCopyRecognizer::new();

    assert_eq!(trigger_decision(&mut rec, VK_LCONTROL, true, base, 5), None);
    assert_eq!(trigger_decision(&mut rec, VK_C, true, base, 5), None);
    for step in [40, 80, 120, 160, 200] {
        assert_eq!(
            trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(step), 5),
            None
        );
    }
    assert_eq!(
        trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(220), 6),
        None
    );

    // One distinct press after release activates because it occurred within 400 ms of first down.
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(320), 6),
        Some(DoubleCopyDecision {
            seq_before_first: 5,
            seq_at_second: 6,
        })
    );
}

#[test]
fn clears_pending_state_on_intervening_chords_and_modifier_combinations() {
    let base = Instant::now();
    let mut rec = DoubleCopyRecognizer::new();

    // 1. Intervening Ctrl+V clears first Ctrl+C.
    trigger_decision(&mut rec, VK_LCONTROL, true, base, 1);
    trigger_decision(&mut rec, VK_C, true, base, 1);
    trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(30), 1);
    trigger_decision(&mut rec, VK_V, true, base + Duration::from_millis(80), 1);
    trigger_decision(&mut rec, VK_V, false, base + Duration::from_millis(100), 1);
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(160), 2),
        None
    );
    trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(180), 2);
    trigger_decision(
        &mut rec,
        VK_LCONTROL,
        false,
        base + Duration::from_millis(190),
        2,
    );

    // 2. Intervening plain key clears pending Ctrl+C.
    let t2 = base + Duration::from_millis(500);
    trigger_decision(&mut rec, VK_LCONTROL, true, t2, 2);
    trigger_decision(&mut rec, VK_C, true, t2, 2);
    trigger_decision(&mut rec, VK_C, false, t2 + Duration::from_millis(20), 2);
    trigger_decision(
        &mut rec,
        VK_LCONTROL,
        false,
        t2 + Duration::from_millis(30),
        2,
    );
    trigger_decision(&mut rec, VK_A, true, t2 + Duration::from_millis(80), 2);
    trigger_decision(&mut rec, VK_A, false, t2 + Duration::from_millis(100), 2);
    trigger_decision(
        &mut rec,
        VK_LCONTROL,
        true,
        t2 + Duration::from_millis(140),
        2,
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, t2 + Duration::from_millis(150), 3),
        None
    );
    rec.reset();

    // 3. Modifier combinations (Ctrl+Shift+C, Ctrl+Alt+C, Ctrl+Win+C, AltGr+C, plain C) never activate.
    let cases = [
        vec![VK_LCONTROL, VK_RSHIFT],
        vec![VK_LCONTROL, VK_LMENU],
        vec![VK_LCONTROL, VK_LWIN],
        vec![VK_LCONTROL, VK_RMENU], // AltGr on European keyboards
        vec![],                      // plain C
    ];
    for (idx, mods) in cases.into_iter().enumerate() {
        rec.reset();
        let t = base + Duration::from_secs((idx as u64) + 2);
        for &m in &mods {
            trigger_decision(&mut rec, m, true, t, 10);
        }
        assert_eq!(trigger_decision(&mut rec, VK_C, true, t, 10), None);
        assert_eq!(
            trigger_decision(&mut rec, VK_C, false, t + Duration::from_millis(20), 10),
            None
        );
        assert_eq!(
            trigger_decision(&mut rec, VK_C, true, t + Duration::from_millis(120), 10),
            None
        );
        for &m in mods.iter().rev() {
            trigger_decision(&mut rec, m, false, t + Duration::from_millis(140), 10);
        }
    }

    // Also test explicit Modifiers struct usage for direct chord helpers.
    assert!(Modifiers::CTRL.is_strict_ctrl());
    assert!(
        !Modifiers {
            ctrl: true,
            shift: true,
            ..Modifiers::NONE
        }
        .is_strict_ctrl()
    );
}

#[test]
fn resets_pending_state_on_stop() {
    let base = Instant::now();
    let mut rec = DoubleCopyRecognizer::new();

    trigger_decision(&mut rec, VK_LCONTROL, true, base, 1);
    trigger_decision(&mut rec, VK_C, true, base, 1);
    trigger_decision(&mut rec, VK_C, false, base + Duration::from_millis(20), 2);

    rec.reset();

    trigger_decision(
        &mut rec,
        VK_LCONTROL,
        true,
        base + Duration::from_millis(100),
        2,
    );
    assert_eq!(
        trigger_decision(&mut rec, VK_C, true, base + Duration::from_millis(110), 2),
        None
    );
}

#[test]
fn settles_clipboard_sequence_updates_across_first_and_second_copy() {
    // Case 1: foreground updates clipboard sequence asynchronously after 2nd press.
    let polls = Cell::new(0u32);
    let updated_on_second = settle_clipboard_copy(
        10,
        10,
        Duration::from_millis(150),
        Duration::from_millis(5),
        || {
            let count = polls.get() + 1;
            polls.set(count);
            if count >= 3 { 11 } else { 10 }
        },
        || false,
    );
    assert!(updated_on_second);
    assert_eq!(polls.get(), 3);

    // Case 2: 2nd press unchanged after 150ms, but 1st press updated sequence during pair -> still valid!
    let accepted_from_first = settle_clipboard_copy(
        10,
        11,
        Duration::from_millis(30),
        Duration::from_millis(5),
        || 11,
        || false,
    );
    assert!(accepted_from_first);

    // Case 3: neither 1st nor 2nd press changed clipboard sequence -> not valid.
    let no_update = settle_clipboard_copy(
        10,
        10,
        Duration::from_millis(25),
        Duration::from_millis(5),
        || 10,
        || false,
    );
    assert!(!no_update);

    // Case 4: cancelled midway returns false promptly.
    let cancelled = settle_clipboard_copy(
        10,
        10,
        Duration::from_millis(150),
        Duration::from_millis(5),
        || 10,
        || true,
    );
    assert!(!cancelled);
}
mod selection_drag {
    use langnext::quick_translate::selection_gesture::{
        CursorShape, DragPhase, DragSample, DragThreshold, PhysicalPoint, SelectionDragCandidate,
        SelectionDragRecognizer,
    };

    fn sample(phase: DragPhase, x: i32, y: i32, cursor: CursorShape) -> DragSample {
        DragSample {
            phase,
            point: PhysicalPoint { x, y },
            cursor,
        }
    }

    fn recognizer() -> SelectionDragRecognizer {
        SelectionDragRecognizer::new(DragThreshold::new(4, 4))
    }

    #[test]
    fn selection_drag_emits_one_candidate_only_on_release() {
        use CursorShape::{IBeam, Other};
        use DragPhase::{Down, Move, Up};

        let mut rec = recognizer();

        assert_eq!(rec.handle(sample(Down, 100, 100, IBeam)), None);
        // Movement inside the system drag rectangle is still a click.
        assert_eq!(rec.handle(sample(Move, 103, 100, IBeam)), None);
        // The drag crosses the threshold, but nothing may fire before release.
        assert_eq!(rec.handle(sample(Move, 104, 100, IBeam)), None);
        assert_eq!(rec.handle(sample(Move, 160, 120, IBeam)), None);
        assert_eq!(rec.handle(sample(Move, 170, 130, Other)), None);

        assert_eq!(
            rec.handle(sample(Up, 170, 130, IBeam)),
            Some(SelectionDragCandidate {
                release: PhysicalPoint { x: 170, y: 130 }
            })
        );
        // One candidate per drag: the release is consumed once.
        assert_eq!(rec.handle(sample(Up, 170, 130, IBeam)), None);
    }

    #[test]
    fn selection_drag_ignores_clicks_short_drags_and_double_clicks() {
        use CursorShape::{IBeam, Other};
        use DragPhase::{Down, Move, Up};

        let mut rec = recognizer();
        // A click in text: no movement at all.
        rec.handle(sample(Down, 200, 200, IBeam));
        assert_eq!(rec.handle(sample(Up, 200, 200, IBeam)), None);

        // A double click never becomes a candidate either.
        rec.handle(sample(Down, 200, 200, IBeam));
        rec.handle(sample(Up, 200, 200, IBeam));
        rec.handle(sample(Down, 200, 200, IBeam));
        assert_eq!(rec.handle(sample(Up, 200, 200, IBeam)), None);

        // A short drag stays inside the rectangle.
        rec.handle(sample(Down, 300, 300, IBeam));
        rec.handle(sample(Move, 302, 301, IBeam));
        assert_eq!(rec.handle(sample(Up, 303, 302, IBeam)), None);

        // Any other button's release without a press reports nothing.
        assert_eq!(rec.handle(sample(Up, 400, 400, Other)), None);
    }

    #[test]
    fn selection_drag_requires_the_ibeam_at_some_point() {
        use CursorShape::{IBeam, Other};
        use DragPhase::{Down, Move, Up};

        let mut rec = recognizer();
        // Dragging a file or another object keeps the arrow cursor.
        rec.handle(sample(Down, 50, 50, Other));
        rec.handle(sample(Move, 260, 90, Other));
        assert_eq!(rec.handle(sample(Up, 260, 90, Other)), None);

        // The next drag over text still reports exactly one candidate.
        rec.handle(sample(Down, 50, 50, Other));
        rec.handle(sample(Move, 120, 60, Other));
        rec.handle(sample(Move, 140, 60, IBeam));
        assert_eq!(
            rec.handle(sample(Up, 150, 60, IBeam)),
            Some(SelectionDragCandidate {
                release: PhysicalPoint { x: 150, y: 60 }
            })
        );
    }

    #[test]
    fn selection_drag_accepts_a_fast_release_without_move_samples() {
        use CursorShape::IBeam;
        use DragPhase::{Down, Up};

        let mut rec = recognizer();
        rec.handle(sample(Down, 10, 10, IBeam));
        assert_eq!(
            rec.handle(sample(Up, 90, 10, IBeam)),
            Some(SelectionDragCandidate {
                release: PhysicalPoint { x: 90, y: 10 }
            })
        );
    }

    #[test]
    fn selection_drag_resets_a_pending_press() {
        use CursorShape::IBeam;
        use DragPhase::{Down, Move, Up};

        let mut rec = recognizer();
        rec.handle(sample(Down, 10, 10, IBeam));
        rec.handle(sample(Move, 90, 10, IBeam));
        rec.reset();
        assert_eq!(rec.handle(sample(Up, 90, 10, IBeam)), None);

        // A second press while the first is pending starts over from the new point.
        rec.handle(sample(Down, 10, 10, IBeam));
        rec.handle(sample(Down, 20, 20, IBeam));
        assert_eq!(
            rec.handle(sample(Up, 30, 20, IBeam)),
            Some(SelectionDragCandidate {
                release: PhysicalPoint { x: 30, y: 20 }
            })
        );
    }

    #[test]
    fn drag_threshold_keeps_a_malformed_metric_usable() {
        use CursorShape::IBeam;
        use DragPhase::{Down, Up};

        let mut rec = SelectionDragRecognizer::new(DragThreshold::new(0, -3));
        rec.handle(sample(Down, 5, 5, IBeam));
        assert_eq!(
            rec.handle(sample(Up, 6, 5, IBeam)),
            Some(SelectionDragCandidate {
                release: PhysicalPoint { x: 6, y: 5 }
            })
        );
    }
}
