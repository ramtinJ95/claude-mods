// Worker adapters by Herdr agent kind. Each exports kind, program (its display
// name), localOnly?, launchArgs(label, profileArgs), sessionPath(agent),
// isReady(agent), view(agent) -> SessionView, deliver(agent, message),
// commands(agent), answer(agent, askId, answers) -> { status?, background?,
// session? } and answerStatus(agent, askId, answers).
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

/** The adapter for a Herdr agent kind or a profile's `agent`; undefined for others. */
export function workerOfKind(kind) {
	return ADAPTERS.get(kind);
}

export function isWorker(agent) {
	return ADAPTERS.has(agent.agent);
}
