// Session-lifetime watcher: streams one JSON line per worker change so the
// mod can reconcile it with `cli.mjs check`. Input on stdin:
// { targets: [{ terminalId, sessionPath? }] }. Exits nonzero when monitoring breaks.
import { snapshot, subscribe } from "./herdr.mjs";
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
		.map(
			({ terminalId }) =>
				agents.find((agent) => agent.terminal_id === terminalId)?.pane_id,
		)
		.filter(Boolean);
	await subscribe(
		[
			...panes.map((paneId) => ({
				type: "pane.agent_status_changed",
				pane_id: paneId,
			})),
			{ type: "pane.closed" },
			{ type: "pane.moved" },
		],
		(event, data) => emit({ type: "event", event, pane: data.pane_id ?? null }),
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
