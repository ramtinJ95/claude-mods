// A wake-up for waits: fires on Herdr events and transcript writes, and
// remembers firing between waits so no change is missed.
import { subscribe, workerSubscriptions } from "./herdr.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";

/** Fires on the worker's status changes, pane moves and closes, and writes to its transcript. */
export function workerTrigger(paneId, path) {
	return openTrigger({
		subscriptions: workerSubscriptions([paneId]),
		paths: path ? [path] : [],
	});
}

/**
 * @param {{ subscriptions?: object[], paths?: string[] }} sources
 * @returns {Promise<{ next(timeoutMs: number): Promise<void>, close(): void }>}
 */
export async function openTrigger({ subscriptions = [], paths = [] }) {
	let dirty = false;
	let failure;
	let wake;
	const fire = () => {
		dirty = true;
		wake?.();
	};
	const fail = (error) => {
		failure = error;
		wake?.();
	};
	const unsubscribe = subscriptions.length
		? await subscribe(subscriptions, fire, fail)
		: () => {};
	let unwatch = () => {};
	try {
		if (paths.length) unwatch = watchSessions(paths, fire, fail);
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return {
		async next(timeoutMs) {
			if (!dirty && !failure)
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			wake = undefined;
			dirty = false;
			if (failure) throw failure;
		},
		close() {
			unsubscribe();
			unwatch();
		},
	};
}
