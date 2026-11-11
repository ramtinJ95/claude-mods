// Worker adapters by agent kind. Each exports kind, program (its display
// name), executable (its command), localOnly?, launchArgs(label, profileArgs),
// resumeArgs(profileArgs, session) (the arguments that reopen a spawned
// worker's saved session), launchLabels?(argv) (Core labels a launch sets on
// the worker's terminal), sessionPath(agent), savedSession(agent) (what
// resumeArgs takes), isReady(agent), view(agent) -> SessionView,
// deliver(agent, message), commands(agent), closeIfIdle(agent) (rejects
// unless the worker is idle), answer(agent, askId, answers) -> { status?,
// session? }, answerStatus(agent, askId, answers) and optional
// awaitStartup(agent), which a launch awaits before delivering anything.
// Optional startupFailure(screen) -> message? explains a terminal where a
// launch failed.
// view().ask is { toolCallId, delivery?: "steer", prompts: [{ title, body?,
// multiple, choices }] }, where "steer" marks a question asked while the worker
// continues; answers are [{ selections?, other?, comment? }] in prompt order,
// whatever question tool the worker uses. A `session` route ({ sessionId,
// text }) from deliver or answer is sent by the hooks side, which alone can
// reach a Claude Code session; its answer status is read afterwards.
import * as claude from "./claude.mjs";
import * as pi from "./pi.mjs";

const ADAPTERS = new Map([
	[pi.kind, pi],
	[claude.kind, claude],
]);

export const WORKER_KINDS = [...ADAPTERS.keys()];

export function workerFor(agent) {
	const adapter = ADAPTERS.get(agent.agent);
	if (!adapter)
		throw new Error(
			`${agent.pane_id} runs ${agent.agent ?? "no agent"}; supported workers: ${WORKER_KINDS.join(", ")}`,
		);
	return adapter;
}

/** The adapter for an agent kind or a profile's `agent`; undefined for others. */
export function workerOfKind(kind) {
	return ADAPTERS.get(kind);
}
