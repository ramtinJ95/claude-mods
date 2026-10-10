// One-shot bridge operations for the Claude Code mod, which has no Node APIs.
// Reads one JSON request on stdin and writes one JSON line: { ok, result } or
// { ok: false, error }. The hooks side validates request fields.
//
// Controller operations run here, beside Claude Code: they own the sender
// identity, profiles and preparation. Each hands its worker-side part to a
// machine operation, run in this process for the local machine or by this
// same file on a remote machine over SSH (`machine.*` ops, `--session`).
import { hostname } from "node:os";
import {
	agentSummary,
	currentPane,
	getAgent,
	request,
	snapshot,
} from "./herdr.mjs";
import { catalog, isLocal, machineFor, remoteCall } from "./machines.mjs";
import {
	listProfiles,
	loadProfile,
	prepareMessage,
	profileArgs,
} from "./profiles.mjs";
import { check, wait } from "./settle.mjs";
import { spawnDirectory, startAgent } from "./spawn.mjs";
import { isWorker, workerFor } from "./workers/index.mjs";

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
		kind: agent.agent,
		...(agent.name ? { name: agent.name } : {}),
		...(path ? { sessionPath: path } : {}),
		// Input IDs are nonempty, so "" reports the next settled reply.
		seenInputId: pendingWork
			? ""
			: ((await worker.view(agent)).input?.id ?? null),
	};
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
	async "machine.start"(request) {
		return agentSummary(await startAgent(request));
	},
	/** Delivers a prepared message; a task also returns the record that watches its outcome. */
	async "machine.deliver"({ target, message, kind }) {
		const { agent, worker } = await resolveWorker(target);
		const record =
			kind === "task" ? await recordFor(agent, worker, false) : undefined;
		const receipt = await worker.deliver(agent, message);
		return {
			agent: agentSummary(agent),
			...(record ? { record } : {}),
			...receipt,
		};
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
	/** Enters the answers unless Pi already recorded them; the status is Pi's record. */
	async "machine.answer"({ target, ask_id: askId, answers }) {
		const { agent, worker } = await resolveWorker(target);
		const prior = await worker.answerStatus(agent, askId, answers);
		if (prior)
			return { agent: agentSummary(agent), status: prior, inputSent: false };
		const [record, { status, background }] = await Promise.all([
			recordFor(agent, worker, true),
			worker.answer(agent, askId, answers),
		]);
		return {
			agent: agentSummary(agent),
			status: status ?? "unknown",
			inputSent: true,
			background,
			record: { ...record, answeringAskId: askId },
		};
	},
	"machine.check"({ record }) {
		return check(record);
	},
	"machine.wait"({ record, timeoutMs }) {
		return wait(record, timeoutMs);
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
			source: source === "recent" ? "recent-unwrapped" : "visible",
			lines,
		});
		return { agent: agentSummary(agent), text: result.read?.text ?? result };
	},
};

function onMachine(machine, op, params, timeoutMs = 60_000) {
	return isLocal(machine)
		? MACHINE_OPS[op](params)
		: remoteCall(machine, op, params, timeoutMs);
}

/** Tags a remote result's record with its machine, which keys it beside its terminal. */
function onRemote(machine, result) {
	return isLocal(machine) || !result.record
		? result
		: { ...result, record: { ...result.record, machine } };
}

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
	async list({ machine, query, status }) {
		const machines = machine
			? isLocal(machine)
				? []
				: [await machineFor(machine)]
			: (await catalog()).filter((entry) => entry.enabled);
		const sources = [
			...(!machine || isLocal(machine) ? [{ id: undefined }] : []),
			...machines,
		];
		const results = await Promise.allSettled(
			sources.map((source) =>
				onMachine(source.id, "machine.list", { status }),
			),
		);
		const needle = query?.trim().toLowerCase();
		const agents = results.flatMap((result, index) =>
			result.status !== "fulfilled"
				? []
				: result.value.map((agent) => ({
						...agent,
						...(sources[index].id
							? { machine: sources[index].id, machine_name: sources[index].label }
							: {}),
					})),
		);
		const unavailable = results.flatMap((result, index) =>
			result.status === "rejected"
				? [
						{
							machine: sources[index].id ?? "local",
							...(sources[index].label ? { machine_name: sources[index].label } : {}),
							error: result.reason.message,
						},
					]
				: [],
		);
		return {
			agents: agents.filter(
				(agent) =>
					!needle ||
					JSON.stringify(Object.values(agent)).toLowerCase().includes(needle),
			),
			...(unavailable.length ? { unavailable } : {}),
		};
	},
	async spawn(params) {
		const { machine } = params;
		const local = isLocal(machine);
		const profile = await loadProfile(params.agent_type.trim());
		const [context, cwd] = await Promise.all([
			controller(),
			onMachine(machine, "machine.directory", {
				params,
				...(local ? { fallbackCwd: params.fallbackCwd } : {}),
			}),
		]);
		const [task, args] = await Promise.all([
			prepareMessage(profile, {
				cwd,
				message: params.message,
				base: params.base,
				local,
			}),
			profileArgs(profile, local),
		]);
		const agent = await onMachine(
			machine,
			"machine.start",
			{
				params,
				args,
				cwd,
				...(local ? { controllerWorkspace: context.pane.workspace_id } : {}),
			},
			120_000,
		);
		const delivery = await onMachine(machine, "machine.deliver", {
			target: agent.target,
			message: attribute(context, task, "task"),
			kind: "task",
		});
		return {
			...onRemote(machine, delivery),
			...(profile.blocking === undefined
				? {}
				: { profileBlocking: profile.blocking }),
		};
	},
	async deliver({ machine, target, message, kind }) {
		const context = await controller();
		return onRemote(
			machine,
			await onMachine(machine, "machine.deliver", {
				target,
				message: attribute(context, message, kind),
				kind,
			}),
		);
	},
	async watch({ machine, target }) {
		return onRemote(machine, await onMachine(machine, "machine.watch", { target }));
	},
	commands({ machine, target }) {
		return onMachine(machine, "machine.commands", { target });
	},
	async answer({ machine, ...params }) {
		return onRemote(machine, await onMachine(machine, "machine.answer", params, 90_000));
	},
	check({ record }) {
		return onMachine(record.machine, "machine.check", { record });
	},
	wait({ record, timeoutMs }) {
		return onMachine(record.machine, "machine.wait", { record, timeoutMs }, timeoutMs + 60_000);
	},
	read({ machine, ...params }) {
		return onMachine(machine, "machine.read", params);
	},
};

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	const { op, ...params } = JSON.parse(input);
	const handler = CONTROLLER_OPS[op] ?? MACHINE_OPS[op];
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
				},
			})}\n`,
		),
);
