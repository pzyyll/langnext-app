// ABOUTME: Custom frameless window titlebar with optional sidebar toggle and controls.
// ABOUTME: Drag only on the title strip; maximize hover opens Windows Snap Layout.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import IconSvgsLnb from "~icons/svgs/lnb";
import IconMaterialSymbolsLightClarifyOutlineSharp from "~icons/material-symbols-light/clarify-outline-sharp";
import IconClarityMinusLine from "~icons/clarity/minus-line";
import IconClarityWindowMaxLine from "~icons/clarity/window-max-line";
import IconClarityWindowRestoreLine from "~icons/clarity/window-restore-line";
import IconClarityCloseLine from "~icons/clarity/close-line";

export type TitleBarProps = {
	title?: string;
	minimize?: boolean;
	maximized?: boolean;
	close?: boolean;
	/** When set, shows a leading control to collapse/expand the app sidebar. */
	sidebarOpen?: boolean;
	onSidebarToggle?: () => void;
	className?: string;
	leading?: ReactNode;
};

/** Match decorum: show snap flyout after hovering maximize ~620ms. */
const SNAP_HOVER_MS = 620;

const controlButtonClassName =
	"inline-flex h-full min-h-0 min-w-10 cursor-default items-center justify-center border-0 bg-transparent px-3 text-ink select-none hover:bg-surface-2 active:bg-surface-3";

const closeButtonClassName =
	"group inline-flex h-full min-h-0 min-w-10 cursor-default items-center justify-center border-0 bg-transparent px-3 text-ink select-none hover:bg-danger hover:text-danger-ink active:bg-danger active:text-danger-ink";

const sidebarToggleClassName =
	"inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-none border-0 bg-transparent text-ink select-none hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink";

export function TitleBar({
	title,
	minimize = true,
	maximized = true,
	close = true,
	sidebarOpen,
	onSidebarToggle,
	className = "",
	leading,
}: TitleBarProps) {
	const { t } = useTranslation();
	const [isMaximized, setIsMaximized] = useState(false);
	const appWindow = useMemo(() => getCurrentWindow(), []);
	const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearSnapTimer = useCallback(() => {
		if (snapTimerRef.current !== null) {
			clearTimeout(snapTimerRef.current);
			snapTimerRef.current = null;
		}
	}, []);

	const refreshMaximized = useCallback(() => {
		void appWindow.isMaximized().then(setIsMaximized);
	}, [appWindow]);

	const onToggleMaximize = useCallback(() => {
		clearSnapTimer();
		void appWindow.toggleMaximize().then(refreshMaximized);
	}, [appWindow, clearSnapTimer, refreshMaximized]);

	const onMaximizeEnter = useCallback(() => {
		clearSnapTimer();
		snapTimerRef.current = setTimeout(() => {
			snapTimerRef.current = null;
			void appWindow
				.setFocus()
				.then(() => invoke("show_snap_overlay"))
				.catch((err: unknown) => {
					console.error("show_snap_overlay failed", err);
				});
		}, SNAP_HOVER_MS);
	}, [appWindow, clearSnapTimer]);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;

		// Sync maximized state from the native window (async → not sync setState in effect).
		void appWindow.isMaximized().then((value) => {
			if (!cancelled) {
				setIsMaximized(value);
			}
		});

		void appWindow
			.onResized(() => {
				void appWindow.isMaximized().then((value) => {
					if (!cancelled) {
						setIsMaximized(value);
					}
				});
			})
			.then((fn) => {
				unlisten = fn;
			});

		return () => {
			cancelled = true;
			clearSnapTimer();
			unlisten?.();
		};
	}, [appWindow, clearSnapTimer]);

	const showSidebarToggle = typeof onSidebarToggle === "function";

	return (
		// Drag is only on the title strip — never wrap the control buttons.
		<div className={`relative z-50 flex h-titlebar-height shrink-0 border-b border-line bg-surface ${className}`}>
			<div className="flex h-full shrink-0 items-center gap-1 pl-2">
				{showSidebarToggle ? (
					<Button
						type="button"
						className={sidebarToggleClassName}
						aria-label={sidebarOpen ? t("titlebar.collapseSidebar") : t("titlebar.expandSidebar")}
						aria-pressed={sidebarOpen}
						onClick={onSidebarToggle}
					>
						<IconMaterialSymbolsLightClarifyOutlineSharp
							className={`pointer-events-none size-4 ${sidebarOpen ? "" : "-scale-x-100"}`}
						/>
					</Button>
				) : null}
				{leading}
			</div>

			<div id="titlebar-title" data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 px-2">
				{title ? (
					<>
						<IconSvgsLnb className="pointer-events-none size-5 shrink-0" />
						<span
							data-tauri-drag-region
							className="pointer-events-none truncate select-none text-body-tight leading-none font-normal text-ink"
						>
							{title}
						</span>
					</>
				) : null}
			</div>

			<div className="relative z-10 flex h-full shrink-0 items-center">
				{minimize ? (
					<button
						type="button"
						id="titlebar-minimize"
						className={controlButtonClassName}
						aria-label={t("titlebar.minimize")}
						onClick={() => void appWindow.minimize()}
					>
						<IconClarityMinusLine className="pointer-events-none size-4" />
					</button>
				) : null}

				{maximized ? (
					<button
						type="button"
						id="titlebar-maximize"
						className={controlButtonClassName}
						aria-label={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
						onClick={onToggleMaximize}
						onMouseEnter={onMaximizeEnter}
						onMouseLeave={clearSnapTimer}
					>
						{isMaximized ? (
							<IconClarityWindowRestoreLine className="pointer-events-none size-4" />
						) : (
							<IconClarityWindowMaxLine className="pointer-events-none size-4" />
						)}
					</button>
				) : null}

				{close ? (
					<button
						type="button"
						id="titlebar-close"
						className={closeButtonClassName}
						aria-label={t("titlebar.close")}
						onClick={() => void appWindow.close()}
					>
						<IconClarityCloseLine className="pointer-events-none size-4 group-hover:text-danger-ink group-active:text-danger-ink" />
					</button>
				) : null}
			</div>
		</div>
	);
}
