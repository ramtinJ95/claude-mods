// Settlement: what a watched worker's state means for its controller.
//
// A record is { terminalId, paneId, sessionPath?, seenInputId }, both IDs the
// worker's Core terminal address on its machine. seenInputId is the latest
// worker input the controller already accounted for; a settled worker whose
// latest input differs has finished new work.
import { agentSummary, getAgent, isCoreError } from "./core.mjs";
import { workerTrigger } from "./trigger.mjs";
import { workerFor } from "./workers/index.mjs";

// A worker can report a settled status before it writes its reply.
const REPLY_GRACE_MS = 5_000;

/** The worker's terminal while it lives; undefined once it finished or was removed. */
async function locate(record) {
	try {
		const agent = await getAgent(record.terminalId);
		return agent.live ? agent : undefined;
	} catch (error) {
		if (isCoreError(error, "not_found")) return undefined;
		throw error;
	}
}

/**
 * states: closed | replaced (new transcript in the same terminal) | working |
 * idle (nothing new) | replying (settled, reply not yet written) | done |
 * question | blocked
 */
async function inspect(record) {
	const agent = await locate(record);
	if (!agent) return { state: "closed" };
	// Pi clears its status and session label between sessions (/new,
	// /resume); the next session publishes them again.
	if (!agent.agent) return { state: "working", agent };
	const worker = workerFor(agent);
	const path = worker.sessionPath(agent);
	const status = agent.agent_status;
	// /new, /resume or a restarted Pi keep the pane but start another
	// transcript; its input cursor restarts there.
	if (record.sessionPath && path && path !== record.sessionPath) {
		const view = await worker.view(agent);
		return {
			state: "replaced",
			agent,
			sessionPath: path,
			inputId: view.input?.id ?? null,
		};
	}
	// A worker spawned with a known session writes its transcript with its
	// first turn; the record learns it then.
	const found = !record.sessionPath && path ? { sessionPath: path } : {};
	if (status === "working" || status === "unknown")
		return { state: "working", agent, ...found };
	const view = await worker.view(agent);
	const inputId = view.input?.id ?? null;
	if (status === "blocked")
		return view.ask
			? { state: "question", agent, inputId, ask: view.ask, ...found }
			: { state: "blocked", agent, inputId, ...found };
	if (inputId === record.seenInputId) return { state: "idle", agent, ...found };
	if (view.assistantAfterInput && view.assistant)
		return { state: "done", agent, inputId, reply: view.assistant, ...found };
	return { state: "replying", agent, inputId, ...found };
}

function finalResult({ agent, ...rest }) {
	return { ...rest, ...(agent ? { agent: agentSummary(agent) } : {}) };
}

/**
 * Inspects once, waiting out the reply grace when a settled worker has not
 * replied yet. `trigger` is the caller's own, when it holds one.
 */
export async function check(record, trigger) {
	let result = await inspect(record);
	if (result.state !== "replying") return finalResult(result);
	const own =
		trigger ??
		(await workerTrigger(
			result.agent.terminal_id,
			workerFor(result.agent).sessionPath(result.agent),
		));
	try {
		const deadline = Date.now() + REPLY_GRACE_MS;
		while (result.state === "replying") {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return finalResult({ ...result, state: "done" });
			await own.next(remaining);
			result = await inspect(record);
		}
		return finalResult(result);
	} finally {
		if (!trigger) own.close();
	}
}

/** Waits until the worker settles new work, asks, blocks or closes, or `deadline` passes. */
export async function wait(record, deadline) {
	let current = { ...record };
	let trigger = await workerTrigger(current.terminalId, current.sessionPath);
	try {
		for (;;) {
			const result = await check(current, trigger);
			if (result.state !== "working" && result.state !== "idle") return result;
			const sessionPath = result.sessionPath ?? current.sessionPath;
			if (sessionPath !== current.sessionPath) {
				current = { ...current, sessionPath };
				trigger.close();
				trigger = await workerTrigger(current.terminalId, current.sessionPath);
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return result;
			await trigger.next(remaining);
		}
	} finally {
		trigger.close();
	}
}
