// Pi transcript reader, from pi-shepherdr. Scans back from EOF along the
// active parentId chain for the latest input, reply and Ask state.

import { open, stat } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(part) =>
				part &&
				typeof part === "object" &&
				part.type === "text" &&
				typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function assistantFromMessage(id, message) {
	if (message.role !== "assistant") return undefined;
	const joined = textOf(message);
	const stopReason =
		typeof message.stopReason === "string" ? message.stopReason : undefined;
	if (!joined && stopReason !== "error") return undefined;
	return {
		id,
		text: joined,
		...(stopReason ? { stopReason } : {}),
	};
}

function inputFromMessage(id, message) {
	if (message.role !== "user") return undefined;
	const joined = textOf(message);
	return joined ? { id, text: joined } : undefined;
}

/** Pi Code Mode runs tools inside an exec cell and records each call as a trace. */
function traceAskResults(message) {
	if (message.role !== "toolResult" || !Array.isArray(message.details?.traces))
		return [];
	return message.details.traces
		.filter(
			(trace) =>
				trace?.name === "ask" &&
				typeof trace.id === "string" &&
				(trace.status === "done" || trace.status === "error"),
		)
		.map((trace) =>
			askResult({
				role: "toolResult",
				toolName: "ask",
				toolCallId: trace.id,
				isError: trace.status === "error",
				details: trace.result?.details,
			}),
		)
		.filter(Boolean);
}

function askChoice(value) {
	if (!value || typeof value !== "object" || typeof value.label !== "string")
		return undefined;
	return {
		label: value.label,
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
	};
}

function askPrompt(value) {
	if (!value || typeof value !== "object" || typeof value.title !== "string")
		return undefined;
	return {
		title: value.title,
		multiple: value.multiple === true,
		choices: (Array.isArray(value.choices) ? value.choices : [])
			.map(askChoice)
			.filter(Boolean),
		...(typeof value.body === "string" ? { body: value.body } : {}),
	};
}

function askCall(value) {
	if (
		!value ||
		typeof value !== "object" ||
		value.type !== "toolCall" ||
		value.name !== "ask" ||
		typeof value.id !== "string"
	)
		return undefined;
	return askFromInput(value.id, value.arguments);
}

function askFromInput(toolCallId, input) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		return undefined;
	const prompts = (Array.isArray(input.prompts) ? input.prompts : [])
		.map(askPrompt)
		.filter(Boolean);
	if (prompts.length === 0) return undefined;
	return {
		toolCallId,
		handoff: input.handoff === true,
		...(input.delivery === "steer" ? { delivery: "steer" } : {}),
		prompts,
	};
}

function askResult(message) {
	if (message.role !== "toolResult" || message.toolName !== "ask")
		return undefined;
	const id = message.toolCallId ?? message.tool_call_id;
	if (typeof id !== "string") return undefined;
	if (message.details?.pending === true) return undefined;
	if (message.isError === true) return [id, { status: "rejected" }];
	if (message.isError !== false) return [id, { status: "unknown" }];
	if (message.details?.dismissed === true) return [id, { status: "rejected" }];
	const rawResponses = message.details?.responses;
	const rawResponseCount = Array.isArray(rawResponses)
		? rawResponses.length
		: -1;
	const responses = Array.isArray(rawResponses)
		? rawResponses
				.map((response) => {
					if (
						!response ||
						typeof response !== "object" ||
						typeof response.id !== "string" ||
						!Array.isArray(response.selections) ||
						!response.selections.every(
							(selection) => typeof selection === "string",
						)
					)
						return undefined;
					return {
						id: response.id,
						selections: response.selections,
						...(typeof response.comment === "string"
							? { comment: response.comment }
							: {}),
					};
				})
				.filter(Boolean)
		: undefined;
	return [
		id,
		{
			status:
				responses &&
				responses.length > 0 &&
				responses.length === rawResponseCount
					? "accepted"
					: "unknown",
			...(responses && responses.length === rawResponseCount
				? { responses }
				: {}),
		},
	];
}

async function sessionView(path, size) {
	let targetId;
	let assistant;
	let assistantDepth;
	let ask;
	const askResults = new Map();
	let depth = 0;
	let input;
	let inputDepth;
	const resolved = new Set();
	const result = () => ({
		...(assistant ? { assistant } : {}),
		...(ask ? { ask } : {}),
		...(askResults.size > 0
			? { askResults: Object.fromEntries(askResults) }
			: {}),
		...(input ? { input } : {}),
		...(assistantDepth !== undefined && inputDepth !== undefined
			? { assistantAfterInput: assistantDepth < inputDepth }
			: {}),
	});
	const inspect = (line) => {
		if (line.length === 0) return false;
		let entry;
		try {
			entry = JSON.parse(line.toString("utf8"));
		} catch {
			return false;
		}
		if (typeof entry.id !== "string") return false;
		targetId ??= entry.id;
		if (entry.id !== targetId) return false;
		const currentDepth = depth;
		depth += 1;
		if (entry.type === "custom" && entry.customType === "pi-ask-active") {
			const update = entry.data;
			if (update?.version === 1 && typeof update.id === "string") {
				if (update.state === "closed") resolved.add(update.id);
				else if (
					update.state === "active" &&
					!ask &&
					!resolved.has(update.id)
				) {
					ask = askFromInput(update.id, update);
				}
			}
		}
		if (entry.type === "custom" && entry.customType === "pi-ask-pending") {
			const update = entry.data;
			if (
				update?.version === 1 &&
				update.state === "closed" &&
				typeof update.id === "string"
			) {
				resolved.add(update.id);
				const result = askResult({
					role: "toolResult",
					toolName: "ask",
					toolCallId: update.id,
					isError: false,
					details: update,
				});
				if (result && !askResults.has(result[0])) askResults.set(...result);
			}
		}
		if (
			!input &&
			entry.type === "custom_message" &&
			entry.customType === "herdr-agent-message" &&
			typeof entry.content === "string" &&
			entry.content
		) {
			input = { id: entry.id, text: entry.content };
			inputDepth = currentDepth;
		}
		const message = entry.message;
		if (message && typeof message === "object") {
			for (const result of [askResult(message), ...traceAskResults(message)]) {
				if (!result) continue;
				resolved.add(result[0]);
				if (!askResults.has(result[0])) askResults.set(...result);
			}
			if (
				(message.role === "toolResult" || message.role === "tool") &&
				message.details?.pending !== true &&
				typeof (message.toolCallId ?? message.tool_call_id) === "string"
			)
				resolved.add(message.toolCallId ?? message.tool_call_id);
			if (!assistant) {
				assistant = assistantFromMessage(entry.id, message);
				if (assistant) assistantDepth = currentDepth;
			}
			if (!input) {
				input = inputFromMessage(entry.id, message);
				if (input) inputDepth = currentDepth;
			}
			if (
				!ask &&
				message.role === "assistant" &&
				Array.isArray(message.content)
			)
				ask = [...message.content]
					.reverse()
					.map(askCall)
					.find(
						(candidate) =>
							candidate &&
							candidate.delivery !== "steer" &&
							!resolved.has(candidate.toolCallId),
					);
		}
		if (typeof entry.parentId !== "string") return true;
		targetId = entry.parentId;
		return false;
	};

	await scanBackward(path, size, inspect);
	return result();
}

/** Feeds `inspect` the first `size` bytes' lines, newest first, until it returns true. */
export async function scanBackward(path, size, inspect) {
	const file = await open(path, "r");
	try {
		let position = size;
		let partial = Buffer.alloc(0);
		while (position > 0) {
			const length = Math.min(READ_CHUNK_BYTES, position);
			position -= length;
			const chunk = Buffer.allocUnsafe(length);
			const { bytesRead } = await file.read(chunk, 0, length, position);
			const data = Buffer.concat([chunk.subarray(0, bytesRead), partial]);
			let lineEnd = data.length;
			for (let index = data.length - 1; index >= 0; index -= 1) {
				if (data[index] !== 0x0a) continue;
				if (inspect(data.subarray(index + 1, lineEnd))) return;
				lineEnd = index;
			}
			partial = data.subarray(0, lineEnd);
		}
		inspect(partial);
	} finally {
		await file.close();
	}
}

/** Wraps `read(path, size)`: `{}` without a file, rereading only when its size or mtime changed. */
export function cachedView(read) {
	const cache = new Map();
	return async (path) => {
		if (!path) return {};
		let metadata;
		try {
			metadata = await stat(path);
		} catch (error) {
			if (error.code === "ENOENT") return {};
			throw error;
		}
		const cached = cache.get(path);
		if (cached?.size === metadata.size && cached.mtimeMs === metadata.mtimeMs)
			return cached.result;
		const result = await read(path, metadata.size);
		cache.set(path, { size: metadata.size, mtimeMs: metadata.mtimeMs, result });
		return result;
	};
}

export const readSessionView = cachedView(sessionView);
