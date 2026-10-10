// Pi workers: transcript reads through Shepherdr's session reader; delivery
// through a worker's Shepherdr receiver when it publishes one, else Herdr's
// terminal prompt.
import { access } from "node:fs/promises";
import { request } from "../herdr.mjs";
import { peerInboxPath, sendPeerMessage } from "../vendor/shepherdr-peer.mjs";
import { readSessionView } from "../vendor/shepherdr-session.mjs";
import { answerAsk, answersMatch } from "./pi-ask.mjs";

export const kind = "pi";

export function answer(agent, askId, answers) {
	return answerAsk(agent, sessionPath(agent), askId, answers);
}

/** accepted | rejected | unknown once Pi recorded the Ask's outcome, else undefined. */
export async function answerStatus(agent, askId, answers) {
	const result = (await view(agent)).askResults?.[askId];
	if (!result) return undefined;
	if (result.status === "rejected") return "rejected";
	return result.status === "accepted" && answersMatch(answers, result.responses)
		? "accepted"
		: "unknown";
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

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** @returns {Promise<{ delivery: "peer" | "terminal", command?: true }>} */
export async function deliver(agent, message) {
	const path = sessionPath(agent);
	if (!path) throw new Error(`${agent.pane_id} has no saved Pi session`);
	if (await exists(peerInboxPath(path, agent.terminal_id))) {
		const receipt = await sendPeerMessage(request, agent, message);
		return { delivery: "peer", ...(receipt.command ? { command: true } : {}) };
	}
	if (agent.agent_status === "blocked")
		throw new Error(
			`${agent.pane_id} is blocked; inspect it with read before sending`,
		);
	// Slash commands must reach Pi's editor bare to expand.
	const command = message.text.trimStart().startsWith("/");
	const text = command
		? message.text
		: [
				message.sender,
				message.context && `<herdr_guidance>${message.context}</herdr_guidance>`,
				message.text,
			]
				.filter(Boolean)
				.join("\n\n");
	await request("agent.prompt", { target: agent.pane_id, text }, 30_000);
	return { delivery: "terminal", ...(command ? { command: true } : {}) };
}
