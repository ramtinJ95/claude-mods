// Session-lifetime watcher: streams one JSON line per worker change so the
// mod can reconcile it with `cli.mjs check`. Input on stdin:
// { targets: [{ machine?, terminalId, sessionPath? }] }. Local targets are
// watched here; each remote machine's targets by a watcher on that machine,
// whose lines are relayed tagged with the machine. A local failure exits
// nonzero; a remote one reports `{ type: "error", machine }` and the rest go on.
import { createInterface } from "node:readline";
import {
	agentByTerminal,
	remoteSession,
	snapshot,
	subscribe,
	workerSubscriptions,
} from "./herdr.mjs";
import { isLocal, spawnRemoteWatcher } from "./machines.mjs";
import { readSessionView } from "./vendor/shepherdr-session.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const remotes = new Set();
const shutdown = (code) => {
	for (const child of remotes) child.kill();
	process.exitCode = code;
	process.stdout.end(() => process.exit());
};
const fail = (error) => {
	emit({ type: "error", message: error.message });
	shutdown(1);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

/** A worker's transcript changed; a background question it holds rides along. */
async function sessionChanged(path) {
	try {
		const { ask } = await readSessionView(path);
		emit({
			type: "session",
			path,
			...(ask?.delivery === "steer" ? { ask } : {}),
		});
	} catch {
		emit({ type: "session", path });
	}
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
		fail,
	);
	const paths = targets.map(({ sessionPath }) => sessionPath).filter(Boolean);
	watchSessions(paths, (path) => void sessionChanged(path), fail);
	emit({ type: "ready" });
	// A background question asked before monitoring began writes nothing more.
	for (const path of paths)
		void readSessionView(path).then(
			({ ask }) => {
				if (ask?.delivery === "steer") emit({ type: "session", path, ask });
			},
			() => undefined,
		);
}

async function watchRemote(machine, targets) {
	const report = (message) => emit({ type: "error", machine, message });
	try {
		const { child } = await spawnRemoteWatcher(
			machine,
			targets.map(({ terminalId, sessionPath }) => ({ terminalId, sessionPath })),
		);
		remotes.add(child);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-4096);
		});
		createInterface({ input: child.stdout }).on("line", (line) => {
			if (!line) return;
			let value;
			try {
				value = JSON.parse(line);
			} catch {
				// Shell startup output, for one: this machine stops, the rest go on.
				report(`unexpected output from the remote watcher: ${line.slice(0, 200)}`);
				child.kill();
				return;
			}
			emit({ ...value, machine });
		});
		child.on("close", (code) => {
			remotes.delete(child);
			report(stderr.trim() || `remote watcher exited ${code}`);
		});
	} catch (error) {
		report(error.message);
	}
}

// The first stdin line holds the targets. On a remote machine stdin stays
// open for the connection's life: its end means the controller went away,
// even when SSH leaves this process running.
const lines = createInterface({ input: process.stdin });
const { targets } = JSON.parse(
	await new Promise((resolve, reject) => {
		lines.once("line", resolve);
		lines.once("close", () => reject(new Error("watcher received no targets")));
	}),
);
if (remoteSession()) lines.once("close", () => shutdown(0));
const groups = new Map();
for (const target of targets) {
	const machine = isLocal(target.machine) ? "local" : target.machine;
	groups.set(machine, [...(groups.get(machine) ?? []), target]);
}
try {
	for (const [machine, group] of groups)
		if (machine === "local") await watchHere(group);
		else void watchRemote(machine, group);
} catch (error) {
	fail(error);
}
