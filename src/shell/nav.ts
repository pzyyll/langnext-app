// ABOUTME: Sidebar nav item list and helpers for active route / scroll transitions.
// ABOUTME: Order in this array defines up/down page transition direction.

export const navItems = [
	{ to: "/", labelKey: "nav.home", exact: true },
	{ to: "/models", labelKey: "nav.models", exact: false },
	{ to: "/about", labelKey: "nav.about", exact: false },
] as const;

export type NavItem = (typeof navItems)[number];

export type ScrollTransitionType = "scroll-down" | "scroll-up";

/** Whether pathname matches a sidebar item (exact or nested prefix). */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
	if (item.exact) {
		return pathname === item.to;
	}
	return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Index in navItems for a path, or -1 if not a known nav route. */
export function getNavIndex(pathname: string): number {
	let bestIndex = -1;
	let bestLength = -1;

	for (let index = 0; index < navItems.length; index += 1) {
		const item = navItems[index];
		if (!isNavItemActive(item, pathname)) {
			continue;
		}
		// Prefer the most specific (longest) matching path when routes nest later.
		if (item.to.length >= bestLength) {
			bestIndex = index;
			bestLength = item.to.length;
		}
	}

	return bestIndex;
}

/**
 * View-transition type from sidebar order:
 * - lower index → higher index  => scroll-down (pages move up)
 * - higher index → lower index  => scroll-up (pages move down)
 */
export function getScrollTransitionType(
	fromPathname: string | undefined,
	toPathname: string,
): ScrollTransitionType | false {
	if (!fromPathname || fromPathname === toPathname) {
		return false;
	}

	const fromIndex = getNavIndex(fromPathname);
	const toIndex = getNavIndex(toPathname);

	if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
		return false;
	}

	return toIndex > fromIndex ? "scroll-down" : "scroll-up";
}
