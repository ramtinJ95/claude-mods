// Answers a Pi Ask by driving its terminal UI, ported from pi-shepherdr's
// src/ask-answer.ts. Every step re-verifies the agent and the Ask frame and
// stops rather than guessing; it never retries input.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgent, request } from "../herdr.mjs";
import { readSessionView } from "../vendor/shepherdr-session.mjs";

const REPHRASE_REQUEST_RESPONSE =
	"User asked for rephrase, split, or follow-up.";

/** Whether Pi recorded exactly these answers. */
export function answersMatch(answers, responses) {
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
		if (selections.length === 0) selections.push(REPHRASE_REQUEST_RESPONSE);
		if (
			[...selections].sort().join("\0") !==
			[...response.selections].sort().join("\0")
		)
			return false;
		return (answer.comment?.trim() || undefined) === response.comment;
	});
}

const down = (count, key) =>
	Array.from({ length: Math.max(0, count) }, () => key);

function answerPlan(prompts, answers, controls) {
	if (answers.length !== prompts.length)
		throw new Error(
			`answer requires ${prompts.length} response${prompts.length === 1 ? "" : "s"}, in prompt order`,
		);
	const steps = [];
	for (const [promptIndex, prompt] of prompts.entries()) {
		const answer = answers[promptIndex];
		const indexes = (answer.selections ?? []).map((label) => {
			const index = prompt.choices.findIndex(
				(choice) => choice.label === label,
			);
			if (index < 0)
				throw new Error(
					`unknown choice ${JSON.stringify(label)} for ${JSON.stringify(prompt.title)}`,
				);
			return index;
		});
		if (new Set(indexes).size !== indexes.length)
			throw new Error(`duplicate choice for ${JSON.stringify(prompt.title)}`);
		if (!prompt.multiple && indexes.length > 1)
			throw new Error(`${JSON.stringify(prompt.title)} accepts one choice`);
		if (!prompt.multiple && indexes.length > 0 && answer.other !== undefined)
			throw new Error(
				`${JSON.stringify(prompt.title)} cannot combine a choice with Other/rephrase`,
			);
		indexes.sort((left, right) => left - right);
		let focus = 0;
		for (const index of indexes) {
			steps.push({
				keys: [...down(index - focus, controls.down), controls.confirm],
			});
			focus = index;
		}
		const needsOther =
			answer.other !== undefined ||
			(indexes.length === 0 && answer.comment !== undefined);
		if (needsOther) {
			steps.push({
				keys: [
					...down(prompt.choices.length - focus, controls.down),
					controls.confirm,
				],
			});
			steps.push({ text: answer.other ?? "", keys: [controls.confirm] });
			focus = prompt.choices.length;
		}
		if (answer.comment !== undefined) {
			steps.push({
				keys: [
					...down(prompt.choices.length + 1 - focus, controls.down),
					controls.confirm,
				],
			});
			steps.push({ text: answer.comment, keys: [controls.next] });
		} else steps.push({ keys: [controls.next] });
	}
	steps.push({ keys: [controls.confirm], final: true });
	return steps;
}

async function readKeybindings() {
	const directory =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	try {
		const value = JSON.parse(
			await readFile(join(directory, "keybindings.json"), "utf8"),
		);
		return typeof value === "object" && value !== null ? value : {};
	} catch {
		return {};
	}
}

function keyFor(bindings, action, fallback) {
	const configured = bindings[action];
	if (typeof configured === "string" && configured) return configured;
	if (Array.isArray(configured)) {
		const first = configured.find(
			(key) => typeof key === "string" && key.length > 0,
		);
		if (typeof first === "string") return first;
		if (configured.length === 0)
			throw new Error(`${action} has no configured keybinding`);
	}
	return fallback;
}

async function screen(paneId) {
	const result = await request("agent.read", {
		target: paneId,
		source: "visible",
		format: "text",
		lines: 80,
		strip_ansi: true,
	});
	if (typeof result?.read?.text !== "string")
		throw new Error("Herdr agent.read returned no text");
	return result.read.text;
}

function askFrame(value) {
	const lines = value.split("\n").map((line) => line.trimEnd());
	// Ask's outer rules start at column zero. Nested editors are indented.
	// Require the tab row so a clipped opening cannot borrow a transcript rule.
	const start = lines.findLastIndex(
		(line, index) =>
			/^─+$/.test(line) &&
			/^ +[□■] 1(?: +[□■] \d+)* +(?:Review|Resume)(?: +Agent continues while you decide)?$/.test(
				lines[index + 1] ?? "",
			),
	);
	if (start < 0) return "";
	const end = lines.findIndex(
		(line, index) => index > start && /^─+$/.test(line),
	);
	return end < 0 || lines[end] !== lines[start]
		? ""
		: lines.slice(start + 1, end).join("\n");
}

function inspectAskScreen(value, ask) {
	const frame = askFrame(value);
	const selected = frame.match(/^>\s+(.*?)\s*$/m)?.[1];
	const review =
		/^\s*Review\s*$/m.test(frame) && frame.includes("enter submit");
	const currentPrompt = review
		? "Review"
		: ask.prompts.find((prompt) =>
				frame.split("\n").some((line) => line.trim() === prompt.title),
			)?.title;
	return {
		recognized:
			Boolean(currentPrompt) ||
			(frame.includes("Other/rephrase") &&
				frame.includes("Comment (optional)")),
		...(currentPrompt ? { currentPrompt } : {}),
		...(selected ? { selected } : {}),
	};
}

function sameAgent(expected, current) {
	return (
		current.pane_id === expected.pane_id &&
		current.workspace_id === expected.workspace_id &&
		current.tab_id === expected.tab_id &&
		current.terminal_id === expected.terminal_id &&
		current.agent_session?.agent === expected.agent_session?.agent &&
		current.agent_session?.kind === expected.agent_session?.kind &&
		current.agent_session?.source === expected.agent_session?.source &&
		current.agent_session?.value === expected.agent_session?.value
	);
}

async function sendInput(agent, step) {
	if (step.text !== undefined) {
		if (!sameAgent(agent, await getAgent(agent.pane_id)))
			throw new Error(`${agent.pane_id} no longer hosts the targeted Pi agent`);
		await request("pane.send_input", {
			pane_id: agent.pane_id,
			text: step.text,
		});
	}
	if (step.keys) {
		if (!sameAgent(agent, await getAgent(agent.pane_id)))
			throw new Error(`${agent.pane_id} no longer hosts the targeted Pi agent`);
		await request("agent.send_keys", {
			target: agent.pane_id,
			keys: step.keys,
		});
	}
}

/**
 * Enters and submits answers to the blocking Ask `askId`. Resolves once the
 * final submission was sent; whether Pi accepted it shows in askResults.
 */
export async function answerAsk(agent, sessionPath, askId, answers) {
	const view = await readSessionView(sessionPath);
	const ask = view.ask;
	if (!ask) throw new Error(`${agent.pane_id} has no live Ask`);
	if (ask.toolCallId !== askId)
		throw new Error(`${agent.pane_id} has a different Ask call`);
	if (ask.delivery === "steer")
		throw new Error(
			"Answering a background Pi Ask is not supported yet; it waits in the worker's pane",
		);
	if (agent.agent_status !== "blocked")
		throw new Error(`${agent.pane_id} is not waiting on Ask`);
	const requireLiveAsk = async () => {
		const current = await getAgent(agent.pane_id);
		if (
			!sameAgent(agent, current) ||
			current.agent_status !== "blocked" ||
			(await readSessionView(sessionPath)).ask?.toolCallId !== askId
		)
			throw new Error("ask closed before all requested answers were entered");
	};
	const initial = inspectAskScreen(await screen(agent.pane_id), ask);
	const first = ask.prompts[0];
	if (
		!initial.recognized ||
		initial.currentPrompt !== first?.title ||
		initial.selected !== (first?.choices[0]?.label ?? "Other/rephrase")
	)
		throw new Error(
			"ask UI is not at the first prompt's default selection; refusing to send guessed keys",
		);
	const bindings = await readKeybindings();
	const plan = answerPlan(ask.prompts, answers, {
		down: keyFor(bindings, "tui.select.down", "down"),
		confirm: keyFor(bindings, "tui.select.confirm", "enter"),
		next: keyFor(bindings, "tui.input.tab", "tab"),
	});
	const final = plan.pop();
	for (const step of plan) {
		await requireLiveAsk();
		await sendInput(agent, step);
		await new Promise((resolve) => setTimeout(resolve, 35));
		await requireLiveAsk();
		if (!inspectAskScreen(await screen(agent.pane_id), ask).recognized)
			throw new Error(
				"ask UI became unrecognized; stopped without retrying input",
			);
	}
	await requireLiveAsk();
	if (inspectAskScreen(await screen(agent.pane_id), ask).currentPrompt !== "Review")
		throw new Error(
			"ask UI is not ready to submit; stopped without retrying input",
		);
	await sendInput(agent, final);
}
