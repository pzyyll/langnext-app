// ABOUTME: Pure helper to register Tauri data-change listeners with safe cleanup.
// ABOUTME: Survives partial listen failures and Strict Mode cancel-after-resolve races.
export type EventUnlisten = () => void;

export type ListenFn = (event: string, handler: () => void) => Promise<EventUnlisten>;

export type DataChangeEventBinding = {
	name: string;
	onEvent: () => void;
};

export type RegisterDataChangeListenersOptions = {
	listen: ListenFn;
	events: readonly DataChangeEventBinding[];
	isCancelled: () => boolean;
	onError?: (event: string, error: unknown) => void;
};

export type RegisterDataChangeListenersResult = {
	/** Successfully registered unlisten functions (empty when cancelled). */
	unlisteners: EventUnlisten[];
	/** Event names whose listen() rejected. */
	failedEvents: string[];
};

/**
 * Register each event independently so one failure does not drop successful
 * listeners, and so a cancelled effect always unsubscribes what it opened.
 */
export async function registerDataChangeListeners(
	options: RegisterDataChangeListenersOptions,
): Promise<RegisterDataChangeListenersResult> {
	const unlisteners: EventUnlisten[] = [];
	const failedEvents: string[] = [];

	await Promise.all(
		options.events.map(async ({ name, onEvent }) => {
			try {
				const unlisten = await options.listen(name, onEvent);
				if (options.isCancelled()) {
					unlisten();
					return;
				}
				unlisteners.push(unlisten);
			} catch (error) {
				failedEvents.push(name);
				options.onError?.(name, error);
			}
		}),
	);

	// Effect may cancel while the last listen was resolving after the per-call check.
	if (options.isCancelled()) {
		for (const unlisten of unlisteners) {
			unlisten();
		}
		unlisteners.length = 0;
	}

	return { unlisteners, failedEvents };
}
