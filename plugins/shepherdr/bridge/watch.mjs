// One machine's watcher for a session's lifetime: streams one JSON line per
// worker change so the mod can reconcile it with `cli.mjs check`. The first
// stdin line is { machine?, targets: [{ terminalId, sessionPath? }] }. For a
// remote machine this process relays that machine's own watcher over SSH,
// tagging each line with the machine. Exits nonzero when monitoring breaks.
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
	agentByTerminal,
	remoteSession,
	snapshot,
	subscribe,
	workerSubscriptions,
} from "./herdr.mjs";
import { resolveMachine, spawnRemoteWatcher } from "./machines.mjs";
import {
	ASK_ENTRY_MARKERS,
	readSessionView,
} from "./vendor/shepherdr-session.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let remote;
const shutdown = (code) => {
	remote?.kill();
	process.exitCode = code;
	process.stdout.end(() => process.exit());
};
const fail = (message) => {
	emit({ type: "error", message });
	shutdown(1);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

/** The worker's open background question, if its transcript holds one. */
async function steerAsk(path) {
	const { ask } = await readSessionView(path);
	return ask?.delivery === "steer" ? ask : undefined;
}

// Only Pi Ask's own entries can open a background question, so a write that
// appends none is reported without reparsing the whole transcript.
const sizes = new Map();
async function appendedAsk(path) {
	const { size } = await stat(path);
	const from = sizes.get(path) ?? 0;
	sizes.set(path, size);
	if (size <= from) return size < from ? steerAsk(path) : undefined;
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(size - from);
		await file.read(buffer, 0, buffer.length, from);
		return ASK_ENTRY_MARKERS.some((marker) => buffer.includes(marker))
			? steerAsk(path)
			: undefined;
	} finally {
		await file.close();
	}
}

async function sessionChanged(path) {
	const ask = await appendedAsk(path).catch(() => undefined);
	emit({ type: "session", path, ...(ask ? { ask } : {}) });
}

async function watchHere(targets) {
	// Saved pane IDs go stale when panes move or close, and Herdr rejects a
	// subscription naming a missing pane. Subscribe to each terminal's current
	// pane; the mod's reconciliation after ready reports the closed ones.
	const { agents } = await snapshot();
	const panes = targets
		.map(({ terminalId }) => agentByTerminal(agents, terminalId)?.pane_id)
		.filter(Boolean);
	await subscribe(
		workerSubscriptions(panes),
		(event, data) =>
			emit({
				type: "event",
				event,
				// A move names the pane by the ID it had before.
				pane:
					(event === "pane.moved" ? data.previous_pane_id : data.pane_id) ??
					null,
				...(typeof data.agent_status === "string"
					? { status: data.agent_status }
					: {}),
			}),
		(error) => fail(error.message),
	);
	const paths = targets.map(({ sessionPath }) => sessionPath).filter(Boolean);
	for (const path of paths)
		sizes.set(path, await stat(path).then(({ size }) => size, () => 0));
	watchSessions(paths, (path) => void sessionChanged(path), (error) =>
		fail(error.message),
	);
	emit({ type: "ready" });
	// A background question asked before monitoring began writes nothing more.
	for (const path of paths) {
		const ask = await steerAsk(path).catch(() => undefined);
		if (ask) emit({ type: "session", path, ask });
	}
}

async function relay(machine, targets) {
	remote = await spawnRemoteWatcher(await resolveMachine(machine), targets);
	let stderr = "";
	remote.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	createInterface({ input: remote.stdout }).on("line", (line) => {
		if (!line) return;
		try {
			emit({ ...JSON.parse(line), machine });
		} catch {
			// Shell startup output, for one, means the stream cannot be trusted.
			fail(`unexpected output from the remote watcher: ${line.slice(0, 200)}`);
		}
	});
	remote.on("close", (code) => fail(stderr.trim() || `remote watcher exited ${code}`));
}

// The first stdin line holds the targets. On a remote machine stdin stays
// open for the connection's life: its end means the controller went away,
// even when SSH leaves this process running.
const lines = createInterface({ input: process.stdin });
const { machine, targets } = JSON.parse(
	await new Promise((resolve, reject) => {
		lines.once("line", resolve);
		lines.once("close", () => reject(new Error("watcher received no targets")));
	}),
);
if (remoteSession()) lines.once("close", () => shutdown(0));
try {
	if (machine) await relay(machine, targets);
	else await watchHere(targets);
} catch (error) {
	fail(error.message);
}
