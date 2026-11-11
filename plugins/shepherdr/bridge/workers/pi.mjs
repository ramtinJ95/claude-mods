// Pi workers: transcripts through the session reader; delivery through the
// worker's Shepherdr receiver, which pi-shepherdr publishes.
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgent, terminalPeer } from "../core.mjs";
import { workerTrigger } from "../trigger.mjs";
import {
	peerInboxPath,
	sendPeerExtensionReply,
	sendPeerMessage,
} from "../vendor/shepherdr-peer.mjs";
import {
	ASK_EXTENSION,
	readSessionView,
} from "../vendor/shepherdr-session.mjs";

// Core reports the worker unblocked within moments of the Ask's UI closing.
const UNBLOCK_TIMEOUT_MS = 15_000;
const REPHRASE_REQUEST_RESPONSE =
	"User asked for rephrase, split, or follow-up.";

export const kind = "pi";
export const program = "Pi";
export const executable = "pi";

/**
 * Spawn's launch arguments: Shepherdr follows the worker through its saved
 * session, and `--shepherdr-worker` tells the worker's extensions to keep
 * human-only features off.
 */
export function launchArgs(label, args) {
	if (args.includes("--no-session"))
		throw new Error(
			"spawn requires a persistent Pi session; remove --no-session from the profile",
		);
	return ["--shepherdr-worker", "--name", label, ...args];
}

// Pi restores these from the saved session; a profile's defaults must not reset them.
const RESTORED_FLAGS = ["--model", "--provider", "--thinking", "--name", "-n"];

/** Launch arguments that reopen a spawned worker's saved session. */
export function resumeArgs(args, session) {
	const kept = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (RESTORED_FLAGS.includes(arg)) index += 1;
		else if (!RESTORED_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) kept.push(arg);
	}
	return ["--shepherdr-worker", ...kept, "--session", session];
}

/** What names the worker's saved session: its session file. */
export function savedSession(agent) {
	return sessionPath(agent);
}

/** Pi refuses flags no extension registered: the worker's pi-shepherdr is missing or too old. */
export function startupFailure(screen) {
	if (/Unknown options?:.*--shepherdr-/.test(screen))
		return "Pi on that machine lacks pi-shepherdr 0.2.25 or newer, which spawned workers need; ask the user to run `pi install npm:@howaboua/pi-shepherdr` there";
}

export function sessionPath(agent) {
	return agent.agent_session?.kind === "path"
		? agent.agent_session.value
		: undefined;
}

export function view(agent) {
	return readSessionView(sessionPath(agent));
}

export function isReady(agent) {
	return Boolean(sessionPath(agent));
}

// pi-shepherdr's own client waits this long for a receiver.
const RECEIVER_WAIT_MS = 30_000;

/**
 * Waits for a spawned worker's Shepherdr receiver, which pi-shepherdr
 * publishes only after Pi's startup hooks, later than Core reports it ready.
 * A Pi that never publishes one cannot take a task.
 */
export async function awaitStartup(agent) {
	const inbox = peerInboxPath(sessionPath(agent), agent.terminal_id);
	const deadline = Date.now() + RECEIVER_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			await stat(inbox);
			return;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await sleep(100);
	}
	throw new Error(
		`Pi published no Shepherdr receiver within ${RECEIVER_WAIT_MS / 1000} s of starting; install or update @howaboua/pi-shepherdr in that Pi`,
	);
}

/** Whether Pi recorded exactly these answers. */
function answersMatch(answers, responses) {
	if (!responses || responses.length !== answers.length) return false;
	return answers.every((answer, index) => {
		const response = responses[index];
		if (!response || response.id !== `p${index + 1}`) return false;
		let selections = [...(answer.selections ?? [])];
		if (answer.other !== undefined) {
			const custom = answer.other.trim() || REPHRASE_REQUEST_RESPONSE;
			selections = [
				...selections.filter((selection) => selection !== custom),
				custom,
			];
		}
		if (
			[...selections].sort().join("\0") !==
			[...response.selections].sort().join("\0")
		)
			return false;
		return (answer.comment?.trim() || undefined) === response.comment;
	});
}

/**
 * Waits out Core's lag after a blocking Ask was answered: the worker stays
 * `blocked` while the Ask's UI closes, which must not read as a new block.
 * Past the bound the worker is reported as it stands, blocked or not.
 */
async function unblockedAfterAnswer(agent, sessionPath, askId, trigger) {
	const unblockBy = Date.now() + UNBLOCK_TIMEOUT_MS;
	for (;;) {
		const current = await getAgent(agent.terminal_id);
		const live = (await readSessionView(sessionPath)).ask;
		if (current.agent_status !== "blocked" || (live && live.toolCallId !== askId))
			return;
		const remaining = unblockBy - Date.now();
		if (remaining <= 0) return;
		await trigger.next(remaining);
	}
}

/** accepted | rejected | unknown once Pi recorded the Ask's outcome, else undefined. */
export async function answerStatus(agent, askId, answers) {
	const result = (await view(agent)).askResults?.[askId];
	if (!result) return undefined;
	if (result.status === "rejected") return "rejected";
	return result.status === "accepted" &&
		answersMatch(answers, result.responses)
		? "accepted"
		: "unknown";
}

/** The slash commands the worker's Shepherdr receiver accepts; works while it is busy. */
export async function commands(agent) {
	const receipt = await sendPeerMessage(
		terminalPeer,
		agent,
		{ text: "", sender: "" },
		{ commands: true },
	);
	return receipt.commands ?? [];
}

/**
 * Answers through Pi Ask's extension reply; resolves once Ask accepted the
 * answers and, for a blocking Ask, Core stopped reporting the worker blocked.
 */
export async function answer(agent, askId, answers) {
	const open = (await view(agent)).openAsks?.[askId];
	if (!open)
		throw new Error(
			`${agent.pane_id} has no open Ask ${askId} it can take answers for; update Pi Ask there, or let the user answer in its terminal`,
		);
	if (open.handoff)
		throw new Error(
			`${agent.pane_id} is waiting on a handoff only the user can complete in its pane`,
		);
	const background = open.delivery === "steer";
	// Opened before sending, so no unblocking is missed.
	const trigger = background
		? undefined
		: await workerTrigger(agent.terminal_id, sessionPath(agent));
	try {
		// Ask validates the answers and resolves only once it accepted them;
		// a refusal rejects with its reason.
		await sendPeerExtensionReply(terminalPeer, agent, {
			extension: ASK_EXTENSION,
			id: askId,
			message: JSON.stringify(answers),
		});
		if (trigger)
			await unblockedAfterAnswer(agent, sessionPath(agent), askId, trigger);
	} finally {
		trigger?.close();
	}
	// Ask's acceptance is the outcome. A Code Mode cell records the Ask
	// only when the whole cell ends, so there may be no record to wait for.
	return { status: "accepted" };
}

/** @returns {Promise<{ delivery: "peer", command?: true, closed?: true }>} */
export async function deliver(agent, message) {
	if (!sessionPath(agent))
		throw new Error(`${agent.pane_id} has no saved Pi session`);
	const receipt = await sendPeerMessage(terminalPeer, agent, message);
	return {
		delivery: "peer",
		...(receipt.command ? { command: true } : {}),
		...(receipt.closed ? { closed: true } : {}),
	};
}

/**
 * Quits the worker only if it is idle when its receiver takes the request,
 * then closes its terminal; a busy or blocked worker rejects.
 */
export async function closeIfIdle(agent) {
	await sendPeerMessage(
		terminalPeer,
		agent,
		{ text: "/quit", sender: '<herdr_sender kind="idle-close" />' },
		{ closeIfIdle: true },
	);
}
