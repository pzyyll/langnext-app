// ABOUTME: Rolling glyph tail shown while stream text is still arriving.
// ABOUTME: Shared by plain TextLoading and Markdown output stream indicators.
import { useEffect, useRef, useState } from "react";

/** Block / shade glyphs that read as "still covered". */
const MASK_GLYPHS = "░▒▓█";
/** Alphanumerics that peek through between masks. */
const LETTER_GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Common punctuation and decorative edge noise mixed into the reel. */
const EDGE_GLYPHS = "╱╲╳*#@!$%&()_+-=[]{}|;:',.<>?/~^";

/**
 * Build a reel that strictly alternates mask → letter (with occasional edge glyphs)
 * so the tail reads as rolling input rather than pure noise.
 */
function buildScrambleReel(): string {
  const masks = [...MASK_GLYPHS];
  const letters = [...LETTER_GLYPHS];
  const edges = [...EDGE_GLYPHS];
  const reel: string[] = [];
  const steps = Math.max(masks.length, letters.length) * 2;

  for (let i = 0; i < steps; i++) {
    if (i % 2 === 0) {
      reel.push(masks[(i / 2) % masks.length]!);
      continue;
    }

    // Every third letter slot drops an edge glyph instead of a letter.
    if (i % 6 === 5) {
      reel.push(edges[Math.floor(i / 6) % edges.length]!);
    } else {
      reel.push(letters[Math.floor(i / 2) % letters.length]!);
    }
  }

  return reel.join("");
}

const SCRAMBLE_REEL = buildScrambleReel();

/** How many rolling glyphs trail the streamed text. */
const SCRAMBLE_TAIL_LENGTH = 3;

/** Target animation frame interval for the rolling glyph tail. */
const SCRAMBLE_FRAME_MS = 1000 / 18;

/** Phase step per frame for the leading (leftmost) slot. */
const LEAD_PHASE_STEP = 1;

/** Extra phase lag between consecutive slots (creates the rolling cascade). */
const SLOT_PHASE_LAG = 2;

/** Opacity drop per trailing slot (leading slot stays fully solid). */
const SLOT_OPACITY_STEP = 0.28;

/** Floor opacity for the farthest trailing slot. */
const SLOT_OPACITY_MIN = 0.28;

function glyphAt(phase: number): string {
  const index = ((phase % SCRAMBLE_REEL.length) + SCRAMBLE_REEL.length) % SCRAMBLE_REEL.length;
  return SCRAMBLE_REEL[index]!;
}

function slotsFromPhase(phase: number): string[] {
  // Leading slot is closest to the text; trailing slots lag behind on the reel.
  return Array.from({ length: SCRAMBLE_TAIL_LENGTH }, (_, slot) => glyphAt(phase - slot * SLOT_PHASE_LAG));
}

function slotOpacity(slot: number): number {
  return Math.max(SLOT_OPACITY_MIN, 1 - slot * SLOT_OPACITY_STEP);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Rolling glyph tail used in place of loading-dots / Streamdown caret while stream text arrives.
 * Renders nothing when inactive; reduced-motion falls back to a static glyph run.
 */
export function StreamScrambleTail({ active }: { active: boolean }) {
  const [slots, setSlots] = useState(() => slotsFromPhase(0));
  const phaseRef = useRef(0);
  const reducedMotion = prefersReducedMotion();

  useEffect(() => {
    if (!active || reducedMotion) {
      return;
    }

    let frameId = 0;
    let lastFrameAt = performance.now();

    const tick = (now: number) => {
      if (now - lastFrameAt >= SCRAMBLE_FRAME_MS) {
        lastFrameAt = now;
        phaseRef.current += LEAD_PHASE_STEP;
        setSlots(slotsFromPhase(phaseRef.current));
      }
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [active, reducedMotion]);

  if (!active) {
    return null;
  }

  const visibleSlots = reducedMotion ? slotsFromPhase(0) : slots;

  return (
    <span className="ms-[0.1em] inline-flex font-mono text-neutral select-none" aria-hidden>
      {visibleSlots.map((glyph, slot) => (
        <span key={slot} className="inline-block w-[1ch] text-center" style={{ opacity: slotOpacity(slot) }}>
          {glyph}
        </span>
      ))}
    </span>
  );
}
