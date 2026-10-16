// One-shot bridge operations for the Claude Code mod, which has no Node APIs.
// Reads one JSON request on stdin and writes one JSON line: { ok, result } or
// { ok: false, error }. The hooks side validates request fields; `budgetMs`
// is how long the caller waits, so nested work fits inside it.
//
// Controller operations run here, beside Claude Code: they own the sender
// identity, profiles and preparation. Each hands its worker-side part to a
// machine operation, run in this process for this machine or by this same
// file on a remote machine over SSH (`machine.*` ops, `--session`).
import { hostname } from "node:os";
import {
	agentSummary,
	currentPane,
	getAgent,
	request,
	snapshot,
} from "./herdr.mjs";
import { catalog, remoteCall, resolveMachine } from "./machines.mjs";
import {
	listProfiles,
	loadProfile,
	prepareMessage,
	profileArgs,
} from "./profiles.mjs";
import { check, wait } from "./settle.mjs";
import { spawnDirectory, startAgent } from "./spawn.mjs";
import { workerTrigger } from "./trigger.mjs";
import { isWorker, workerFor, workerOfKind } from "./workers/index.mjs";

const DELEGATED_WORKER_GUIDANCE =
	"If blocked mid-run, use a question-asking tool, not peer messages. Without one, end with the blocker. Finish with an assistant reply, not a separate send report; never watch your parent.";
// Room to return a result before the caller stops waiting.
const MARGIN_MS = 3_000;
// A worker records a sent answer within moments of receiving it.
const ANSWER_RECORD_MS = 10_000;
const REMOTE_CLAUDE =
	"Claude Code agents on another machine are not supported; use Pi agents there or Claude Code agents on this machine";

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

async function resolveWorker(target) {
	const agent = await getAgent(target);
	if (agent.pane_id === process.env.HERDR_PANE_ID)
		throw new Error("refusing to target this Claude Code session");
	return { agent, worker: workerFor(agent) };
}

async function recordFor(agent, worker, pendingWork) {
	const path = worker.sessionPath(agent);
	return {
		terminalId: agent.terminal_id,
		paneId: agent.pane_id,
		...(agent.name ? { name: agent.name } : {}),
		...(path ? { sessionPath: path } : {}),
		// Input IDs are nonempty, so "" reports the next settled reply.
		seenInputId: pendingWork
			? ""
			: ((await worker.view(agent)).input?.id ?? null),
	};
}

/** Delivers a prepared message; a task also returns the record that watches its outcome. */
async function deliver(target, message, kind) {
	const { agent, worker } = await resolveWorker(target);
	const record =
		kind === "task" ? await recordFor(agent, worker, false) : undefined;
	const receipt = await worker.deliver(agent, message);
	return { agent: agentSummary(agent), ...(record ? { record } : {}), ...receipt };
}

/** Worker-side operations; they never touch the controller's pane. */
const MACHINE_OPS = {
	async "machine.list"({ status }) {
		const snap = await snapshot();
		return snap.agents
			.filter((agent) => agent.pane_id !== process.env.HERDR_PANE_ID)
			.filter((agent) => !status || agent.agent_status === status)
			.map((agent) => ({
				...agentSummary(agent),
				...labels(snap, agent),
				...(isWorker(agent) ? {} : { unsupported: true }),
			}));
	},
	"machine.directory"({ params, fallbackCwd }) {
		return spawnDirectory(params, fallbackCwd);
	},
	/** Starts the worker and delivers its first task in one call. */
	async "machine.start"({ message, ...start }) {
		const { agent, notice } = await startAgent(start);
		const delivered = await deliver(agent.pane_id, message, "task");
		return notice ? { ...delivered, notice } : delivered;
	},
	"machine.deliver"({ target, message, kind }) {
		return deliver(target, message, kind);
	},
	async "machine.watch"({ target }) {
		const { agent, worker } = await resolveWorker(target);
		// A blocked worker resumes its current input once answered.
		const pending = ["working", "unknown", "blocked"].includes(
			agent.agent_status,
		);
		return {
			agent: agentSummary(agent),
			record: await recordFor(agent, worker, pending),
		};
	},
	async "machine.commands"({ target }) {
		const { agent, worker } = await resolveWorker(target);
		return { agent: agentSummary(agent), commands: await worker.commands(agent) };
	},
	/**
	 * Enters the answers unless the worker already recorded them; the status is
	 * the worker's record. A record comes back only when input was sent. A
	 * `session` route still has to be sent, and its status read with
	 * `machine.answered`.
	 */
	async "machine.answer"({ target, ask_id: askId, answers }) {
		const { agent, worker } = await resolveWorker(target);
		const prior = await worker.answerStatus(agent, askId, answers);
		if (prior) return { agent: agentSummary(agent), status: prior };
		const [record, { status, background, session }] = await Promise.all([
			recordFor(agent, worker, true),
			worker.answer(agent, askId, answers),
		]);
		return {
			agent: agentSummary(agent),
			...(session ? { session } : { status: status ?? "unknown" }),
			background,
			record,
		};
	},
	/** Waits for the worker to record answers sent through its session. */
	async "machine.answered"({ target, ask_id: askId, answers }, deadline) {
		const { agent, worker } = await resolveWorker(target);
		const trigger = await workerTrigger(agent.pane_id, worker.sessionPath(agent));
		try {
			const recordBy = Math.min(deadline - MARGIN_MS, Date.now() + ANSWER_RECORD_MS);
			for (;;) {
				const status = await worker.answerStatus(agent, askId, answers);
				if (status) return { agent: agentSummary(agent), status };
				const remaining = recordBy - Date.now();
				if (remaining <= 0)
					throw new Error(
						"The answers were sent, but the worker recorded no result; inspect it with read before retrying",
					);
				await trigger.next(remaining);
			}
		} finally {
			trigger.close();
		}
	},
	"machine.check"({ record }) {
		return check(record);
	},
	"machine.wait"({ record }, deadline) {
		return wait(record, deadline - MARGIN_MS);
	},
	async "machine.read"({ target, source = "latest", lines = 80 }) {
		const { agent, worker } = await resolveWorker(target);
		if (source === "latest") {
			const view = await worker.view(agent);
			return {
				agent: agentSummary(agent),
				...(view.assistant ? { reply: view.assistant.text } : {}),
				...(view.ask ? { ask: view.ask } : {}),
			};
		}
		const result = await request("agent.read", {
			target: agent.pane_id,
			source: source === "recent" ? "recent_unwrapped" : "visible",
			lines,
		});
		return { agent: agentSummary(agent), text: result.read?.text ?? result };
	},
};

/**
 * Runs a machine operation: here for this machine (`machine` undefined), over
 * SSH for a catalog entry. A remote record comes back tagged with its machine,
 * which keys it beside its terminal.
 */
async function onMachine(machine, op, params, deadline) {
	if (!machine) return MACHINE_OPS[op](params, deadline);
	const result = await remoteCall(machine, op, params, deadline, MARGIN_MS);
	// Claude Code's session messages reach only sessions on this machine.
	if (result?.session) throw new Error(REMOTE_CLAUDE);
	return result?.record
		? { ...result, record: { ...result.record, machine: machine.id } }
		: result;
}

/** The catalog entry for a request's machine, or undefined for this one. */
const machineEntry = (id) => (id ? resolveMachine(id) : undefined);

/** This Claude Code pane and the local Herdr snapshot. */
async function controller() {
	const [pane, snap] = await Promise.all([currentPane(), snapshot()]);
	return { pane, snap };
}

function attribute({ pane, snap }, text, kind) {
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

const CONTROLLER_OPS = {
	profiles() {
		return listProfiles();
	},
	async machines() {
		return (await catalog()).map(({ id, label, enabled }) => ({
			id,
			label,
			enabled,
		}));
	},
	/** Agents on one machine, or on this one and every enabled remote machine. */
	async list({ machine, query, status }, deadline) {
		const sources = machine
			? [await resolveMachine(machine)]
			: [undefined, ...(await catalog()).filter((entry) => entry.enabled)];
		const results = await Promise.allSettled(
			sources.map((source) =>
				onMachine(source, "machine.list", { status }, deadline),
			),
		);
		const needle = query?.trim().toLowerCase();
		const agents = [];
		const unavailable = [];
		results.forEach((result, index) => {
			const source = sources[index];
			const where = source ? { machine: source.id, machine_name: source.label } : {};
			if (result.status === "rejected")
				unavailable.push({ ...where, error: result.reason.message });
			else
				for (const agent of result.value)
					if (
						!needle ||
						JSON.stringify(Object.values(agent)).toLowerCase().includes(needle)
					)
						agents.push({
							...agent,
							...where,
							...(source && workerOfKind(agent.kind)?.localOnly
								? { unsupported: true }
								: {}),
						});
		});
		return { agents, ...(unavailable.length ? { unavailable } : {}) };
	},
	async spawn(params, deadline) {
		const machine = await machineEntry(params.machine);
		const profile = await loadProfile(params.agent_type.trim());
		if (machine && workerOfKind(profile.agent).localOnly) throw new Error(REMOTE_CLAUDE);
		const [context, cwd] = await Promise.all([
			controller(),
			onMachine(
				machine,
				"machine.directory",
				{ params, ...(machine ? {} : { fallbackCwd: params.fallbackCwd }) },
				deadline,
			),
		]);
		const [task, args] = await Promise.all([
			prepareMessage(profile, {
				cwd,
				message: params.message,
				base: params.base,
				local: !machine,
			}),
			profileArgs(profile, !machine),
		]);
		const delivery = await onMachine(
			machine,
			"machine.start",
			{
				params,
				agent: profile.agent,
				args,
				cwd,
				message: attribute(context, task, "task"),
				...(machine ? {} : { controllerWorkspace: context.pane.workspace_id }),
			},
			deadline,
		);
		return {
			...delivery,
			...(profile.blocking === undefined
				? {}
				: { profileBlocking: profile.blocking }),
		};
	},
	async deliver({ machine, target, message, kind }, deadline) {
		const [entry, context] = await Promise.all([
			machineEntry(machine),
			controller(),
		]);
		return onMachine(
			entry,
			"machine.deliver",
			{ target, message: attribute(context, message, kind), kind },
			deadline,
		);
	},
	async watch({ machine, target }, deadline) {
		return onMachine(await machineEntry(machine), "machine.watch", { target }, deadline);
	},
	async commands({ machine, target }, deadline) {
		return onMachine(await machineEntry(machine), "machine.commands", { target }, deadline);
	},
	async answer({ machine, ...params }, deadline) {
		return onMachine(await machineEntry(machine), "machine.answer", params, deadline);
	},
	async answered({ machine, ...params }, deadline) {
		return onMachine(await machineEntry(machine), "machine.answered", params, deadline);
	},
	async check({ record }, deadline) {
		return onMachine(await machineEntry(record.machine), "machine.check", { record }, deadline);
	},
	async wait({ record }, deadline) {
		return onMachine(await machineEntry(record.machine), "machine.wait", { record }, deadline);
	},
	async read({ machine, ...params }, deadline) {
		return onMachine(await machineEntry(machine), "machine.read", params, deadline);
	},
};

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const { op, budgetMs = 55_000, ...params } = JSON.parse(input);
	const handler = CONTROLLER_OPS[op] ?? MACHINE_OPS[op];
	if (!handler) throw new Error(`unknown bridge op ${op}`);
	return handler(params, Date.now() + budgetMs);
}

main().then(
	(result) => process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`),
	(error) =>
		process.stdout.write(
			`${JSON.stringify({
				ok: false,
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			})}\n`,
		),
);
