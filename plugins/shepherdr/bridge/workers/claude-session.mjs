// Claude Code transcript reader. Scans back from EOF along the active
// uuid/parentUuid chain for the latest input, reply and AskUserQuestion
// results, in the SessionView shape the Pi reader returns. Claude Code records
// a question only once it is settled; the worker's hook publishes open ones.
import { cachedView, scanBackward } from "../vendor/shepherdr-session.mjs";

// Local slash commands and interruptions are recorded as user rows, but they
// are not work given to the worker.
const NOT_INPUT = /^\s*(?:<command-name>|<local-command-|\[Request interrupted)/;

function blocks(message) {
	return Array.isArray(message?.content) ? message.content : [];
}

function textOf(message) {
	if (typeof message?.content === "string") return message.content;
	return blocks(message)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/**
 * Work given to the worker: a prompt typed, submitted or sent by a peer, or
 * one that arrived mid-turn and joined it as a queued command. Returns its text.
 */
function inputText(entry) {
	if (entry.type === "attachment") {
		const queued = entry.attachment;
		if (queued?.type !== "queued_command" || queued.commandMode !== "prompt")
			return undefined;
		const text = textOf({ content: queued.prompt });
		return text && !NOT_INPUT.test(text) ? text : undefined;
	}
	if (entry.type !== "user" || entry.isCompactSummary || entry.toolUseResult)
		return undefined;
	if (entry.isMeta && entry.origin?.kind !== "peer") return undefined;
	if (blocks(entry.message).some((block) => block?.type === "tool_result"))
		return undefined;
	const text = textOf(entry.message);
	return text && !NOT_INPUT.test(text) ? text : undefined;
}

export function askPrompts(input) {
	const questions = Array.isArray(input?.questions) ? input.questions : [];
	return questions
		.filter((question) => typeof question?.question === "string")
		.map((question) => ({
			title: question.question,
			multiple: question.multiSelect === true,
			choices: (Array.isArray(question.options) ? question.options : [])
				.filter((option) => typeof option?.label === "string")
				.map((option) => ({
					label: option.label,
					...(typeof option.description === "string" && option.description
						? { description: option.description }
						: {}),
				})),
		}));
}

function askResult(block, entry) {
	if (block.is_error === true) return { status: "rejected" };
	const answers = entry.toolUseResult?.answers;
	return answers && typeof answers === "object"
		? { status: "accepted", answers, prompts: askPrompts(entry.toolUseResult) }
		: { status: "unknown" };
}

async function sessionView(path, size) {
	let targetId;
	let input;
	let assistant;
	// The newest reply is the run of assistant text up to the tool call or
	// prompt before it.
	let replyOpen = true;
	let replyText = "";
	let replyId;
	let replyError = false;
	let assistantAfterInput;
	const askResults = new Map();
	const result = () => ({
		...(assistant ? { assistant } : {}),
		...(askResults.size > 0
			? { askResults: Object.fromEntries(askResults) }
			: {}),
		...(input ? { input } : {}),
		...(assistantAfterInput !== undefined ? { assistantAfterInput } : {}),
	});
	const closeReply = () => {
		if (!replyOpen) return;
		replyOpen = false;
		if (replyId && (replyText || replyError))
			assistant = {
				id: replyId,
				text: replyText,
				...(replyError ? { stopReason: "error" } : {}),
			};
	};
	const inspect = (line) => {
		if (line.length === 0) return false;
		let entry;
		try {
			entry = JSON.parse(line.toString("utf8"));
		} catch {
			return false;
		}
		if (typeof entry.uuid !== "string" || entry.isSidechain) return false;
		targetId ??= entry.uuid;
		if (entry.uuid !== targetId) return false;
		if (entry.type === "user") {
			for (const block of blocks(entry.message))
				if (
					block?.type === "tool_result" &&
					typeof block.tool_use_id === "string" &&
					entry.toolUseResult?.questions &&
					!askResults.has(block.tool_use_id)
				)
					askResults.set(block.tool_use_id, askResult(block, entry));
			if (replyId) closeReply();
		}
		if (!input && (entry.type === "user" || entry.type === "attachment")) {
			const text = inputText(entry);
			if (text) {
				if (replyId) closeReply();
				input = { id: entry.uuid, text };
				assistantAfterInput = Boolean(assistant);
			}
		}
		if (entry.type === "assistant") {
			const content = blocks(entry.message);
			const toolUses = content.filter((block) => block?.type === "tool_use");
			if (toolUses.length && replyId) closeReply();
			else if (replyOpen && !toolUses.length) {
				const text = textOf(entry.message);
				if (text || entry.isApiErrorMessage) {
					replyId ??= entry.uuid;
					replyText = text + replyText;
					if (entry.isApiErrorMessage) replyError = true;
				}
			}
		}
		if (input && !replyOpen) return true;
		// A compaction boundary starts a new chain; its logical parent continues
		// the old one, where the task's input is.
		const parent = entry.parentUuid ?? entry.logicalParentUuid;
		if (typeof parent !== "string") return true;
		targetId = parent;
		return false;
	};

	await scanBackward(path, size, inspect);
	closeReply();
	return result();
}

export const readClaudeSessionView = cachedView(sessionView);
