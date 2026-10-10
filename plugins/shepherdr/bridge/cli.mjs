// One-shot bridge operations for the Claude Code mod, which has no Node APIs.
// Reads one JSON request on stdin and writes one JSON line: { ok, result } or
// { ok: false, error }.
import { hostname } from "node:os";
import { currentPane, getAgent, request, snapshot } from "./herdr.mjs";
import {
	listProfiles,
	loadProfile,
	prepareMessage,
} from "./profiles.mjs";
import { check, wait } from "./settle.mjs";
import { spawnAgent, spawnDirectory } from "./spawn.mjs";
import { isWorker, WORKER_KINDS, workerFor } from "./workers/index.mjs";

const DELEGATED_WORKER_GUIDANCE =
	"If blocked mid-run, use a question-asking tool, not peer messages. Without one, end with the blocker. Finish with an assistant reply, not a separate send report; never watch your parent.";

function xml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\n", "&#10;")
		.replaceAll("\r", "&#13;");
}

function labels(snap, agent) {
	const workspace = snap.workspaces.find(
		(item) => item.workspace_id === agent.workspace_id,
	)?.label;
	const tab = snap.tabs.find((item) => item.tab_id === agent.tab_id)?.label;
	return {
		...(workspace ? { workspace_name: workspace } : {}),
		...(tab ? { tab_name: tab } : {}),
	};
}

async function attribute(text, kind) {
	const [pane, snap] = await Promise.all([currentPane(), snapshot()]);
	const paneName = pane.label || pane.title;
	const source = {
		kind,
		host: hostname(),
		session: process.env.HERDR_SESSION || "default",
		pane: pane.pane_id,
		workspace: pane.workspace_id,
		tab: pane.tab_id,
		...(pane.name ? { name: pane.name } : {}),
		...(paneName ? { pane_name: paneName } : {}),
		...labels(snap, pane),
	};
	const attributes = Object.entries(source)
		.map(([key, value]) => `${key}="${xml(value)}"`)
		.join(" ");
	return {
		sender: `<herdr_sender ${attributes} />`,
		text,
		...(kind === "task" ? { context: DELEGATED_WORKER_GUIDANCE } : {}),
	};
}

function summary(agent) {
	return {
		target: agent.pane_id,
		...(agent.name ? { name: agent.name } : {}),
		kind: agent.agent,
		status: agent.agent_status,
		terminal: agent.terminal_id,
		...(agent.foreground_cwd || agent.cwd
			? { cwd: agent.foreground_cwd || agent.cwd }
			: {}),
	};
}

async function resolveWorker(target) {
	if (!target?.trim()) throw new Error("target is required");
	const agent = await getAgent(target.trim());
	if (agent.pane_id === process.env.HERDR_PANE_ID)
		throw new Error("refusing to target this Claude Code session");
	workerFor(agent);
	return agent;
}

async function recordFor(agent, pendingWork) {
	const worker = workerFor(agent);
	const view = await worker.view(agent);
	return {
		terminalId: agent.terminal_id,
		paneId: agent.pane_id,
		kind: agent.agent,
		...(agent.name ? { name: agent.name } : {}),
		...(worker.sessionPath(agent)
			? { sessionPath: worker.sessionPath(agent) }
			: {}),
		// Input IDs are nonempty, so "" reports the next settled reply.
		seenInputId: pendingWork ? "" : (view.input?.id ?? null),
	};
}

async function deliverTo(agent, text, kind) {
	const record = await recordFor(agent, false);
	const receipt = await workerFor(agent).deliver(
		agent,
		await attribute(text, kind),
	);
	return { agent: summary(agent), record, ...receipt };
}

const OPS = {
	async profiles() {
		return { ...(await listProfiles()), workers: WORKER_KINDS };
	},
	async list({ query, status }) {
		const snap = await snapshot();
		const needle = query?.trim().toLowerCase();
		return snap.agents
			.filter((agent) => agent.pane_id !== process.env.HERDR_PANE_ID)
			.filter((agent) => !status || agent.agent_status === status)
			.map((agent) => ({
				...summary(agent),
				...labels(snap, agent),
				...(isWorker(agent) ? {} : { unsupported: true }),
			}))
			.filter(
				(agent) =>
					!needle ||
					JSON.stringify(Object.values(agent)).toLowerCase().includes(needle),
			);
	},
	async spawn(params) {
		if (!params.agent_type?.trim()) throw new Error("agent_type is required");
		if (!params.label?.trim()) throw new Error("label is required");
		if (!params.message?.trim()) throw new Error("message is required");
		const profile = await loadProfile(params.agent_type.trim());
		const cwd = await spawnDirectory(params, params.fallbackCwd);
		const task = await prepareMessage(profile, {
			cwd,
			message: params.message,
			base: params.base,
		});
		const agent = await spawnAgent(profile, params, cwd);
		return {
			...(await deliverTo(agent, task, "task")),
			...(profile.blocking === undefined
				? {}
				: { profileBlocking: profile.blocking }),
		};
	},
	async deliver({ target, message, kind }) {
		if (!message?.trim()) throw new Error("message is required");
		return deliverTo(await resolveWorker(target), message, kind);
	},
	async watch({ target }) {
		const agent = await resolveWorker(target);
		// A blocked worker resumes its current input once answered.
		const pending = ["working", "unknown", "blocked"].includes(
			agent.agent_status,
		);
		return { agent: summary(agent), record: await recordFor(agent, pending) };
	},
	check({ record }) {
		return check(record);
	},
	wait({ record, timeoutMs }) {
		return wait(record, timeoutMs);
	},
	async read({ target, source = "latest", lines = 80 }) {
		const agent = await resolveWorker(target);
		if (source === "latest") {
			const view = await workerFor(agent).view(agent);
			return {
				agent: summary(agent),
				...(view.assistant ? { reply: view.assistant.text } : {}),
				...(view.ask ? { ask: view.ask } : {}),
			};
		}
		const result = await request("agent.read", {
			target: agent.pane_id,
			source: source === "recent" ? "recent-unwrapped" : "visible",
			lines,
		});
		return { agent: summary(agent), text: result.read?.text ?? result };
	},
};

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const { op, ...params } = JSON.parse(input);
	const handler = OPS[op];
	if (!handler) throw new Error(`unknown bridge op ${op}`);
	return handler(params);
}

main().then(
	(result) => process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`),
	(error) =>
		process.stdout.write(
			`${JSON.stringify({
				ok: false,
				error: {
					message: error instanceof Error ? error.message : String(error),
					...(typeof error?.code === "string" ? { code: error.code } : {}),
				},
			})}\n`,
		),
);
