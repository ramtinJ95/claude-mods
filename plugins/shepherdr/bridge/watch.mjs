// Session-lifetime watcher: streams one JSON line per worker change so the
// mod can reconcile it with `cli.mjs check`. Input on stdin:
// { targets: [{ terminalId, sessionPath? }] }. Exits nonzero when monitoring breaks.
import {
	agentByTerminal,
	snapshot,
	subscribe,
	workerSubscriptions,
} from "./herdr.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (error) => {
	emit({ type: "error", message: error.message });
	process.exitCode = 1;
	process.stdout.end(() => process.exit());
};

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { targets } = JSON.parse(input);

try {
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
	watchSessions(
		targets.map(({ sessionPath }) => sessionPath).filter(Boolean),
		(path) => emit({ type: "session", path }),
		fail,
	);
	emit({ type: "ready" });
} catch (error) {
	fail(error);
}
