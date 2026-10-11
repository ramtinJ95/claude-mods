// Claude Code workers: transcripts through the Claude session reader; tasks
// and answers through Claude Code's own cross-session messages, which only
// the hooks side can send, so deliver and answer return a `session` route for
// it; slash commands through Herdr's terminal prompt.
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgent, isHerdrErrorCode, request } from "../herdr.mjs";
import { workerTrigger } from "../trigger.mjs";
import { closeExitedPane } from "../vendor/shepherdr-peer.mjs";
import { checkAnswers } from "./answers.mjs";
import { askPrompts, readClaudeSessionView } from "./claude-session.mjs";
import { envelopeText } from "./envelope.mjs";

export const kind = "claude";
export const program = "Claude Code";
/** Tasks and answers travel as Claude Code cross-session messages, which stay on one machine. */
export const localOnly = true;

/** Spawn's launch arguments, without `--name`: its name bar leaves the question dialog outside the screen region Herdr reads. */
export function launchArgs(_label, args) {
	return args;
}

// Claude Code exits within moments of /exit; its pane then holds a shell.
const EXIT_TIMEOUT_MS = 15_000;

const COMMANDS = [
	{ name: "quit", description: "Exit Claude Code and close its pane" },
	{ name: "compact", description: "Compact context: /compact [instructions]" },
	{ name: "clear", description: "Start a new conversation" },
];

function sessionId(agent) {
	return agent.agent_session?.kind === "id" ? agent.agent_session.value : undefined;
}

function projectsDir() {
	return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** Must match askFile in hooks/register.ts. */
function askFile(id) {
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(data, "claude-shepherdr", "asks", `${id}.json`);
}

/** Claude Code names a project's directory after its path, every other character a dash. */
const projectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const transcripts = new Map();

/** The transcript once Claude Code has written it; a new session has none yet. */
export function sessionPath(agent) {
	const id = sessionId(agent);
	if (!id) return undefined;
	if (transcripts.has(id)) return transcripts.get(id);
	const projects = projectsDir();
	const file = `${id}.jsonl`;
	const path =
		[agent.cwd, agent.foreground_cwd]
			.filter(Boolean)
			.map((cwd) => join(projects, projectDir(cwd), file))
			.find((candidate) => existsSync(candidate)) ??
		// Long paths are shortened; any session directory may hold it.
		(existsSync(projects)
			? readdirSync(projects)
					.map((dir) => join(projects, dir, file))
					.find((candidate) => existsSync(candidate))
			: undefined);
	// A session's transcript never moves; one not written yet is looked up again.
	if (path) transcripts.set(id, path);
	return path;
}

/**
 * The question the worker's Shepherdr hook published before opening its
 * dialog; it writes `{}` once the dialog settles.
 */
async function publishedAsk(id) {
	let text;
	try {
		text = await readFile(askFile(id), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	const { toolCallId, questions } = JSON.parse(text);
	if (typeof toolCallId !== "string") return undefined;
	const prompts = askPrompts({ questions });
	return prompts.length ? { toolCallId, prompts } : undefined;
}

export async function view(agent) {
	const transcript = await readClaudeSessionView(sessionPath(agent));
	const id = sessionId(agent);
	// Not gated on Herdr's status: an attached session started with --name
	// shows its open dialog as idle.
	const ask = id && (await publishedAsk(id));
	// A result in the transcript outranks a file its hook could not clear.
	return ask && !transcript.askResults?.[ask.toolCallId]
		? { ...transcript, ask }
		: transcript;
}

export function isReady(agent) {
	return Boolean(sessionId(agent));
}

/** AskUserQuestion's answers object, keyed by question, for shared-shape answers. */
function questionAnswers(prompts, answers) {
	checkAnswers(prompts, answers);
	const result = { answers: {}, annotations: {} };
	for (const [index, prompt] of prompts.entries()) {
		const answer = answers[index];
		const other = answer.other?.trim();
		const parts = [...(answer.selections ?? []), ...(other ? [other] : [])];
		if (parts.length === 0)
			throw new Error(`${JSON.stringify(prompt.title)} needs a selection or other`);
		if (!prompt.multiple && parts.length > 1)
			throw new Error(`${JSON.stringify(prompt.title)} accepts one answer`);
		result.answers[prompt.title] = parts.join(", ");
		const comment = answer.comment?.trim();
		if (comment) result.annotations[prompt.title] = { notes: comment };
	}
	return result;
}

/** accepted | rejected | unknown once Claude Code recorded the question's result, else undefined. */
export async function answerStatus(agent, askId, answers) {
	const result = (await view(agent)).askResults?.[askId];
	if (!result) return undefined;
	if (result.status !== "accepted") return result.status;
	let expected;
	try {
		expected = questionAnswers(result.prompts, answers).answers;
	} catch {
		return "unknown";
	}
	const recorded = result.answers;
	return Object.keys(expected).every((title) => recorded[title] === expected[title])
		? "accepted"
		: "unknown";
}

export async function commands() {
	return COMMANDS;
}

/** The frame the worker's Shepherdr hook takes in place of its open question's dialog. */
function answerFrame(askId, payload) {
	// Escaped `<` keeps the frame's body free of its closing tag.
	const json = JSON.stringify(payload).replaceAll("<", "\\u003c");
	return `<shepherdr_answer ask="${askId}">${json}</shepherdr_answer>`;
}

/** Validates the answers; the hooks side sends them to the worker's session. */
export async function answer(agent, askId, answers) {
	const id = sessionId(agent);
	const { ask } = await view(agent);
	if (!ask) throw new Error(`${agent.pane_id} has no open question`);
	if (ask.toolCallId !== askId)
		throw new Error(`${agent.pane_id} has a different open question`);
	const payload = questionAnswers(ask.prompts, answers);
	return { session: { sessionId: id, text: answerFrame(askId, payload) } };
}

/** Waits for Claude Code to leave the pane, then closes it. */
async function closeAfterExit(agent) {
	const trigger = await workerTrigger(agent.pane_id);
	try {
		const deadline = Date.now() + EXIT_TIMEOUT_MS;
		for (;;) {
			let current;
			try {
				current = await getAgent(agent.pane_id);
			} catch (error) {
				if (!isHerdrErrorCode(error, "agent_not_found")) throw error;
			}
			if (
				!current ||
				current.terminal_id !== agent.terminal_id ||
				current.agent !== kind
			)
				break;
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new Error(
					`${agent.pane_id} received /exit but Claude Code is still running; check it with read`,
				);
			await trigger.next(remaining);
		}
	} finally {
		trigger.close();
	}
	await closeExitedPane(request, agent, sessionId(agent));
}

async function command(agent, text) {
	if (!["idle", "done"].includes(agent.agent_status))
		throw new Error(
			`${agent.pane_id} is ${agent.agent_status}; send ${text.split(/\s/)[0]} once it settles`,
		);
	const quit = /^\/quit\s*$/.test(text);
	await request(
		"agent.prompt",
		{ target: agent.pane_id, text: quit ? "/exit" : text },
		30_000,
	);
	if (quit) await closeAfterExit(agent);
	return { delivery: "terminal", command: true };
}

/** @returns {Promise<{ delivery: "session" | "terminal", command?: true, session?: { sessionId: string, text: string } }>} */
export async function deliver(agent, message) {
	const id = sessionId(agent);
	if (!id) throw new Error(`${agent.pane_id} has no Claude Code session`);
	const text = message.text.trim();
	if (text.startsWith("/")) return command(agent, text);
	return {
		delivery: "session",
		session: { sessionId: id, text: envelopeText(message) },
	};
}
