//! Recognizes a possible text drag from left-button samples, without reading any text.

/// The pointer shape the platform reports for one sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorShape {
    /// The standard text I-beam: the only shape that hints at selectable text.
    IBeam,
    /// Every other shape, including an application's custom cursor.
    Other,
}

/// A physical screen point, as the low-level mouse hook reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalPoint {
    pub x: i32,
    pub y: i32,
}

/// The system drag rectangle in physical pixels (`SM_CXDRAG` and `SM_CYDRAG`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DragThreshold {
    width: i32,
    height: i32,
}

impl DragThreshold {
    /// Keeps a malformed system metric from turning every click into a drag.
    pub fn new(width: i32, height: i32) -> Self {
        Self {
            width: width.max(1),
            height: height.max(1),
        }
    }

    /// Whether the pointer left the rectangle that still counts as a click.
    pub fn exceeded(self, from: PhysicalPoint, to: PhysicalPoint) -> bool {
        (to.x - from.x).unsigned_abs() >= self.width as u32
            || (to.y - from.y).unsigned_abs() >= self.height as u32
    }
}

/// What the left button did for one sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragPhase {
    Down,
    Move,
    Up,
}

/// One left-button sample from the low-level mouse hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DragSample {
    pub phase: DragPhase,
    pub point: PhysicalPoint,
    pub cursor: CursorShape,
}

/// The release of a drag that may have selected text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionDragCandidate {
    pub release: PhysicalPoint,
}

/// Left-button drag recognizer: down, move, and up samples in; a qualifying release point out.
#[derive(Debug, Clone, Copy)]
pub struct SelectionDragRecognizer {
    threshold: DragThreshold,
    press: Option<PhysicalPoint>,
    dragged: bool,
    saw_ibeam: bool,
}

impl SelectionDragRecognizer {
    pub fn new(threshold: DragThreshold) -> Self {
        Self {
            threshold,
            press: None,
            dragged: false,
            saw_ibeam: false,
        }
    }

    /// Consumes one sample. Only a release can report a candidate.
    ///
    /// A candidate needs both a left-button drag that leaves the system drag rectangle and the
    /// standard I-beam cursor at some point of the drag. The I-beam is a hint, not proof: an
    /// application that draws its own text cursor never reaches it.
    pub fn handle(&mut self, sample: DragSample) -> Option<SelectionDragCandidate> {
        match sample.phase {
            DragPhase::Down => {
                self.press = Some(sample.point);
                self.dragged = false;
                self.saw_ibeam = sample.cursor == CursorShape::IBeam;
                None
            }
            DragPhase::Move => {
                let press = self.press?;
                if sample.cursor == CursorShape::IBeam {
                    self.saw_ibeam = true;
                }
                if !self.dragged && self.threshold.exceeded(press, sample.point) {
                    self.dragged = true;
                }
                None
            }
            DragPhase::Up => {
                let press = self.press.take()?;
                let dragged = self.dragged || self.threshold.exceeded(press, sample.point);
                let saw_ibeam = self.saw_ibeam || sample.cursor == CursorShape::IBeam;
                self.dragged = false;
                self.saw_ibeam = false;
                if !dragged || !saw_ibeam {
                    return None;
                }
                Some(SelectionDragCandidate {
                    release: sample.point,
                })
            }
        }
    }

    /// Drops a pending press, so a stopped listener never resumes a drag.
    pub fn reset(&mut self) {
        self.press = None;
        self.dragged = false;
        self.saw_ibeam = false;
    }
}
