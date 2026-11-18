/** Navigation leave guard called before leaving an editor page. Returning false blocks immediate navigation until the guard runs `proceed`. */
export type NavigationLeaveGuard = (proceed: () => void) => boolean;
