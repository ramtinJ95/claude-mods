// Worker adapters by Herdr agent kind. Each exports kind, sessionPath(agent),
// isReady(agent), view(agent) -> SessionView, deliver(agent, message),
// answer(agent, askId, answers) and answerStatus(agent, askId, answers).
// view().ask is { toolCallId, prompts: [{ title, body?, multiple, choices }] }
// and answers are [{ selections?, other?, comment? }] in prompt order, whatever
// question tool the worker uses. A Claude Code adapter joins here once Claude
// Code can receive peer messages.
import * as pi from "./pi.mjs";

const ADAPTERS = new Map([[pi.kind, pi]]);

export const WORKER_KINDS = [...ADAPTERS.keys()];

export function workerFor(agent) {
	const adapter = ADAPTERS.get(agent.agent);
	if (!adapter)
		throw new Error(
			`${agent.pane_id} runs ${agent.agent ?? "no agent"}; supported workers: ${WORKER_KINDS.join(", ")}`,
		);
	return adapter;
}

export function isWorker(agent) {
	return ADAPTERS.has(agent.agent);
}
