// Settlement: what a watched worker's state means for its controller.
//
// A record is { terminalId, paneId, sessionPath?, seenInputId, answeringAskId? }.
// seenInputId is the latest worker input the controller already accounted for;
// a settled worker whose latest input differs has finished new work.
// answeringAskId names an Ask the controller answered: Herdr keeps the worker
// blocked while that Ask's UI closes, which is not a new question.
import {
	agentByTerminal,
	agentSummary,
	getAgent,
	isHerdrErrorCode,
	snapshot,
	subscribe,
	workerSubscriptions,
} from "./herdr.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";
import { workerFor } from "./workers/index.mjs";

// Herdr can report a settled status before the worker writes its reply.
const REPLY_GRACE_MS = 5_000;

async function locate(record) {
	try {
		const agent = await getAgent(record.paneId);
		if (agent.terminal_id === record.terminalId) return agent;
	} catch (error) {
		if (!isHerdrErrorCode(error, "agent_not_found")) throw error;
	}
	return agentByTerminal((await snapshot()).agents, record.terminalId);
}

/**
 * states: closed | replaced (new transcript in the same pane) | working |
 * idle (nothing new) | replying (settled, reply not yet written) | done |
 * question | blocked
 */
async function inspect(record) {
	const agent = await locate(record);
	if (!agent) return { state: "closed" };
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
	if (status === "working" || status === "unknown")
		return { state: "working", agent };
	const view = await worker.view(agent);
	const inputId = view.input?.id ?? null;
	if (status === "blocked") {
		const answered = record.answeringAskId;
		if (
			answered &&
			(view.ask?.toolCallId === answered ||
				(!view.ask && view.askResults?.[answered]))
		)
			return { state: "working", agent };
		return view.ask
			? { state: "question", agent, inputId, ask: view.ask }
			: { state: "blocked", agent, inputId };
	}
	if (inputId === record.seenInputId) return { state: "idle", agent };
	if (view.assistantAfterInput && view.assistant)
		return { state: "done", agent, inputId, reply: view.assistant };
	return { state: "replying", agent, inputId };
}

/** Fires on the worker's status changes, pane moves/closes and transcript writes. */
async function openTrigger(paneId, path) {
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
	const unsubscribe = await subscribe(workerSubscriptions([paneId]), fire, fail);
	let unwatch = () => {};
	try {
		if (path) unwatch = watchSessions([path], fire, fail);
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return {
		paneId,
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
		(await openTrigger(
			result.agent.pane_id,
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

/** Waits until the worker settles new work, asks, blocks or closes, or the timeout passes. */
export async function wait(record, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let current = { ...record };
	let trigger = await openTrigger(current.paneId, current.sessionPath);
	try {
		for (;;) {
			const result = await check(current, trigger);
			if (result.state !== "working" && result.state !== "idle") return result;
			if (result.agent && result.agent.target !== trigger.paneId) {
				current = { ...current, paneId: result.agent.target };
				trigger.close();
				trigger = await openTrigger(current.paneId, current.sessionPath);
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
