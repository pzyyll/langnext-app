// ABOUTME: AutoAnimate plugin for Quick Translate result-card list motion.
// ABOUTME: Stronger enter/exit than library defaults; respects reduced motion.
import { getTransitionSizes, type AutoAnimationPlugin } from "@formkit/auto-animate";

/** Enter/exit/reorder duration for result cards. */
export const SLOT_LIST_ANIMATION_MS = 250;

/** Vertical offset for card enter/exit (px). */
const SLOT_LIST_OFFSET_PX = 8;

/** Exit scale — small enough to stay tasteful, large enough to read. */
const SLOT_LIST_EXIT_SCALE = 0.97;

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Custom list plugin.
 *
 * Parameter order matches the library's runtime calls:
 * - add:    (el, "add", newCoords)
 * - remove: (el, "remove", oldCoords)
 * - remain: (el, "remain", oldCoords, newCoords)
 *
 * Plugin mode bypasses the library's built-in reduced-motion gate, so we zero
 * durations ourselves when the user prefers reduced motion.
 */
export const slotListAutoAnimate: AutoAnimationPlugin = (el, action, firstCoords, secondCoords) => {
	const duration = prefersReducedMotion() ? 0 : SLOT_LIST_ANIMATION_MS;

	if (action === "add") {
		return new KeyframeEffect(
			el,
			[
				{ transform: `translateY(${SLOT_LIST_OFFSET_PX}px)`, opacity: 0 },
				{ transform: "translateY(0)", opacity: 1 },
			],
			{ duration, easing: "ease-out" },
		);
	}

	if (action === "remove") {
		return new KeyframeEffect(
			el,
			[
				{ transform: "translateY(0) scale(1)", opacity: 1 },
				{
					transform: `translateY(-${SLOT_LIST_OFFSET_PX / 2}px) scale(${SLOT_LIST_EXIT_SCALE})`,
					opacity: 0,
				},
			],
			{ duration, easing: "ease-in" },
		);
	}

	// remain — FLIP siblings when a neighbor is added/removed
	const oldCoords = firstCoords;
	const newCoords = secondCoords;
	if (!oldCoords || !newCoords) {
		return new KeyframeEffect(el, [], { duration: 0 });
	}

	const deltaX = oldCoords.left - newCoords.left;
	const deltaY = oldCoords.top - newCoords.top;
	const [widthFrom, widthTo, heightFrom, heightTo] = getTransitionSizes(el, oldCoords, newCoords);

	const start: Keyframe = { transform: `translate(${deltaX}px, ${deltaY}px)` };
	const end: Keyframe = { transform: "translate(0, 0)" };

	if (widthFrom !== widthTo) {
		start.width = `${widthFrom}px`;
		end.width = `${widthTo}px`;
	}
	if (heightFrom !== heightTo) {
		start.height = `${heightFrom}px`;
		end.height = `${heightTo}px`;
	}

	return new KeyframeEffect(el, [start, end], {
		duration,
		easing: "ease-in-out",
	});
};
