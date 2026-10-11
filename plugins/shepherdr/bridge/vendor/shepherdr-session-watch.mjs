// Transcript watcher, from pi-shepherdr.
import { watch } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Watch only named sessions' directories, including file replacement.
 * @param {string[]} paths absolute transcript paths
 * @param {(path: string) => void} onChange
 * @param {(error: Error) => void} onError
 * @returns {() => void} close
 */
export function watchSessions(paths, onChange, onError) {
	/** @type {import('node:fs').FSWatcher[]} */
	const watchers = [];
	/** @type {Map<string, NodeJS.Timeout>} */
	const timers = new Map();
	/** @type {Map<string, Set<string>>} */
	const directories = new Map();
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		for (const watcher of watchers) watcher.close();
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	};
	try {
		for (const path of new Set(paths)) {
			const files = directories.get(dirname(path)) ?? new Set();
			files.add(path);
			directories.set(dirname(path), files);
		}
		for (const [directory, files] of directories) {
			const watcher = watch(
				directory,
				{ persistent: false },
				(_event, filename) => {
					for (const path of files) {
						if (filename !== null && filename.toString() !== basename(path))
							continue;
						if (timers.has(path) || closed) continue;
						const timer = setTimeout(() => {
							timers.delete(path);
							if (!closed) onChange(path);
						}, 25);
						timer.unref();
						timers.set(path, timer);
					}
				},
			);
			watcher.on("error", (error) => {
				close();
				onError(error);
			});
			watchers.push(watcher);
		}
		return close;
	} catch (error) {
		close();
		throw error;
	}
}
