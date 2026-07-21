// ABOUTME: Sidebar nav item list and helpers for active route / scroll transitions.
// ABOUTME: Order in this array defines up/down page transition direction.

/** Icon keys consumed by the shell sidebar (material-symbols-light). */
export type NavIconId = "translate" | "book" | "history" | "neurology" | "document_scanner" | "settings";

export const navItems = [
  { to: "/translate", labelKey: "nav.translate", exact: true, icon: "translate" },
  { to: "/translate/profiles", labelKey: "nav.translateProfiles", exact: true, icon: "book" },
  { to: "/history", labelKey: "nav.history", exact: false, icon: "history" },
  { to: "/models", labelKey: "nav.models", exact: false, icon: "neurology" },
  { to: "/ocr", labelKey: "nav.ocr", exact: false, icon: "document_scanner" },
  { to: "/settings", labelKey: "nav.settings", exact: false, icon: "settings" },
] as const satisfies ReadonlyArray<{
  to: string;
  labelKey: string;
  exact: boolean;
  icon: NavIconId;
}>;

export type NavItem = (typeof navItems)[number];

/** Primary sidebar links (Translate / Profiles / History / Models / OCR). Settings is rendered at the footer. */
export const primaryNavItems = [navItems[0], navItems[1], navItems[2], navItems[3], navItems[4]] as const;

/** Settings entry shown in the sidebar footer. */
export const settingsNavItem = navItems[5];

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
