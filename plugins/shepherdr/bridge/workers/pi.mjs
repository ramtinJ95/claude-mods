// Pi workers: transcripts through the session reader; delivery through the
// worker's Shepherdr receiver when it publishes one, else Herdr's terminal
// prompt.
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { request } from "../herdr.mjs";
import {
	peerInboxPath,
	sendPeerExtensionReply,
	sendPeerMessage,
} from "../vendor/shepherdr-peer.mjs";
import {
	ASK_EXTENSION,
	readSessionView,
} from "../vendor/shepherdr-session.mjs";
import { envelopeText } from "./envelope.mjs";
import { workerTrigger } from "../trigger.mjs";
import { answerAsk, answersMatch, unblockedAfterAnswer } from "./pi-ask.mjs";

export const kind = "pi";
export const program = "Pi";

/** Spawn's launch arguments: Shepherdr follows the worker through its saved session. */
export function launchArgs(label, args) {
	if (args.includes("--no-session"))
		throw new Error(
			"spawn requires a persistent Pi session; remove --no-session from the profile",
		);
	return ["--name", label, ...args];
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
 * publishes only after Pi's startup hooks, later than Herdr reports it ready.
 * A Pi without one is left to `deliver`'s terminal route once the wait ends.
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
		request,
		agent,
		{ text: "", sender: "" },
		{ commands: true },
	);
	if (!receipt?.commands) throw noReceiver(agent, "list its commands");
	return receipt.commands;
}

function noReceiver(agent, purpose) {
	return new Error(
		`${agent.pane_id} has no Shepherdr receiver to ${purpose}; install @howaboua/pi-shepherdr in that Pi`,
	);
}

/**
 * Answers through Pi Ask's extension reply when it published the question,
 * else enters them in its terminal UI. Resolves the status Pi recorded and
 * whether the Ask ran in the background.
 */
export async function answer(agent, askId, answers) {
	const open = (await view(agent)).openAsks?.[askId];
	if (open) {
		if (open.handoff)
			throw new Error(
				`${agent.pane_id} is waiting on a handoff only the user can complete in its pane`,
			);
		const background = open.delivery === "steer";
		// Opened before sending, so no unblocking is missed.
		const trigger = background
			? undefined
			: await workerTrigger(agent.pane_id, sessionPath(agent));
		try {
			// Ask validates the answers and resolves only once it accepted them;
			// a refusal rejects with its reason.
			const sent = await sendPeerExtensionReply(request, agent, {
				extension: ASK_EXTENSION,
				id: askId,
				message: JSON.stringify(answers),
			});
			if (!sent) throw noReceiver(agent, "take the answer");
			if (trigger)
				await unblockedAfterAnswer(agent, sessionPath(agent), askId, trigger);
		} finally {
			trigger?.close();
		}
		// Ask's acceptance is the outcome. A Code Mode cell records the Ask
		// only when the whole cell ends, so there may be no record to wait for.
		return { status: "accepted", background };
	}
	const ask = await answerAsk(agent, sessionPath(agent), askId, answers);
	return {
		status: await answerStatus(agent, askId, answers),
		background: ask.delivery === "steer",
	};
}

/** @returns {Promise<{ delivery: "peer" | "terminal", command?: true }>} */
export async function deliver(agent, message) {
	if (!sessionPath(agent))
		throw new Error(`${agent.pane_id} has no saved Pi session`);
	// Rejects a blocked or replaced worker before either route sends anything.
	const receipt = await sendPeerMessage(request, agent, message);
	if (receipt)
		return { delivery: "peer", ...(receipt.command ? { command: true } : {}) };
	// Slash commands must reach Pi's editor bare to expand.
	const command = message.text.trimStart().startsWith("/");
	const text = command ? message.text : envelopeText(message);
	await request("agent.prompt", { target: agent.pane_id, text }, 30_000);
	return { delivery: "terminal", ...(command ? { command: true } : {}) };
}
