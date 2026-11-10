// A wake-up for waits: fires on Core events and transcript writes, and
// remembers firing between waits so no change is missed.
import { subscribe } from "./core.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";

/**
 * Fires on any change Core reports for the worker's terminal (status, exit,
 * labels) and on writes to its transcript.
 * @returns {Promise<{ next(timeoutMs: number): Promise<void>, close(): void }>}
 */
export async function workerTrigger(terminal, path) {
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
	const { close: unsubscribe } = await subscribe({ terminal }, fire, fail);
	let unwatch = () => {};
	try {
		if (path) unwatch = watchSessions([path], fire, fail);
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
