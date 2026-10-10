// Pi workers: transcripts through the session reader; delivery through the
// worker's Shepherdr receiver when it publishes one, else Herdr's terminal
// prompt.
import { request } from "../herdr.mjs";
import { sendPeerMessage } from "../vendor/shepherdr-peer.mjs";
import { readSessionView } from "../vendor/shepherdr-session.mjs";
import { answerAsk, answersMatch } from "./pi-ask.mjs";

export const kind = "pi";

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

/** Enters the answers and resolves with the status Pi recorded. */
export async function answer(agent, askId, answers) {
	await answerAsk(agent, sessionPath(agent), askId, answers);
	return answerStatus(agent, askId, answers);
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
