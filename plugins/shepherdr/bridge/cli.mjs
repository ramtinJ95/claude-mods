// One-shot bridge operations for the Claude Code mod, which has no Node APIs.
// Reads one JSON request on stdin and writes one JSON line: { ok, result } or
// { ok: false, error }. The hooks side validates request fields; `budgetMs`
// is how long the caller waits, so nested work fits inside it.
//
// Controller operations run here, beside Claude Code in a Core terminal: they
// own the sender identity, profiles, preparation and launches. Each hands its
// worker-side part to a machine operation, run in this process for this
// machine or by this same file on a remote machine through `hc exec`
// (`machine.*` ops), which reaches that machine's Core with `hc connect`.
import { hostname } from "node:os";
import {
	agentSummary,
	CLAUDE_SESSION_LABEL,
	closeTerminal,
	coreIdentity,
	getAgent,
	localAgents,
	ownTerminal,
	request,
} from "./core.mjs";
import { catalog, remoteCall, resolveMachine } from "./machines.mjs";
import {
	listProfiles,
	loadProfile,
	prepareMessage,
	profileArgs,
} from "./profiles.mjs";
import { check, wait } from "./settle.mjs";
import { awaitWorker, launch, launchTarget } from "./spawn.mjs";
import { workerTrigger } from "./trigger.mjs";
import { workerFor, workerOfKind } from "./workers/index.mjs";

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

async function resolveWorker(target) {
	const agent = await getAgent(target);
	if (agent.terminal_id === ownTerminal())
		throw new Error("refusing to target this Claude Code session");
	if (!agent.live) throw new Error(`${agent.pane_id} has finished; nothing runs there`);
	return { agent, worker: workerFor(agent) };
}

/** A listed agent: its summary and the Herdr space a new tab can join. */
const listed = (agent) => ({
	...agentSummary(agent),
	...(agent.workspace_id ? { workspace: agent.workspace_id } : {}),
});

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

/** Worker-side operations; they never touch the controller's terminal. */
const MACHINE_OPS = {
	async "machine.list"({ status }) {
		// Only Pi and Claude Code workers report what a worker needs.
		return (await localAgents())
			.filter((agent) => agent.agent && agent.terminal_id !== ownTerminal())
			.filter((agent) => !status || agent.agent_status === status)
			.map(listed);
	},
	/** The worker's directory and program, and the names and spaces live here. */
	async "machine.target"({ params, kind, fallbackCwd }) {
		const [target, agents] = await Promise.all([
			launchTarget(params, kind, fallbackCwd),
			localAgents(),
		]);
		return {
			...target,
			agents: agents.map(({ name, workspace_id }) => ({
				...(name ? { name } : {}),
				...(workspace_id ? { workspace_id } : {}),
			})),
		};
	},
	/** Waits for a launched worker, then delivers its first task. */
	async "machine.started"({ address, kind, cwd, message }) {
		const { agent, notice } = await awaitWorker(address, kind, cwd);
		const delivered = await deliver(agent.terminal_id, message, "task");
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
		const trigger = await workerTrigger(agent.terminal_id, worker.sessionPath(agent));
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
		const result = await request(
			"terminal.read",
			{ terminal: agent.terminal_id, lines: source === "recent" ? lines : 0 },
			30_000,
		);
		return {
			agent: agentSummary(agent),
			text: result.text,
			...(result.complete === false ? { incomplete: result.why ?? true } : {}),
		};
	},
};

/**
 * Runs a machine operation: here for this machine (`machine` undefined),
 * through `hc exec` for a catalog entry. A remote record comes back tagged with its machine,
 * which keys it beside its terminal.
 */
async function onMachine(machine, op, params, deadline) {
	if (!machine) return MACHINE_OPS[op](params, deadline);
	const result = await remoteCall(machine, op, params, deadline, MARGIN_MS);
	// Claude Code's session messages reach only sessions on this machine.
	if (result?.session) throw new Error(REMOTE_CLAUDE);
	return result?.record
		? {
				...result,
				record: { ...result.record, machine: machine.id, machineName: machine.name },
			}
		: result;
}

/** The catalog entry for a request's machine, or undefined for this one. */
const machineEntry = (id) => (id ? resolveMachine(id) : undefined);

/** This Claude Code terminal and its Core's identity. */
async function controller() {
	const terminal = ownTerminal();
	if (!terminal)
		throw new Error(
			"Claude Code is not running in a Herdr Core terminal; start it from the Herdr app or with hc",
		);
	const [pane, core] = await Promise.all([getAgent(terminal), coreIdentity()]);
	return { pane, core };
}

function attribute({ pane, core }, text, kind) {
	const source = {
		kind,
		host: hostname(),
		machine: core.id,
		terminal: pane.terminal_id,
		...(pane.workspace_id ? { workspace: pane.workspace_id } : {}),
		...(pane.tab_id ? { tab: pane.tab_id } : {}),
		...(pane.name ? { name: pane.name } : {}),
		...(pane.title ? { pane_name: pane.title } : {}),
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
	/** A worker's own Shepherdr publishing its session on its terminal, so its controller finds it. */
	async label({ sessionId }) {
		const terminal = ownTerminal();
		if (!terminal) return { labeled: false };
		await request("terminal.label", {
			terminal,
			labels: { [CLAUDE_SESSION_LABEL]: sessionId },
		});
		return { labeled: true };
	},
	profiles() {
		return listProfiles();
	},
	async machines() {
		return (await catalog()).map(({ id, name, state }) => ({ id, name, state }));
	},
	/** Agents on one machine, or on this one and every connected remote machine. */
	async list({ machine, query, status }, deadline) {
		const machines = machine ? [] : await catalog();
		const sources = machine
			? [await resolveMachine(machine)]
			: [undefined, ...machines.filter((entry) => entry.state === "connected")];
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
			const where = source ? { machine: source.id, machine_name: source.name } : {};
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
		for (const entry of machines)
			if (entry.state !== "connected")
				unavailable.push({
					machine: entry.id,
					machine_name: entry.name,
					error: `${entry.state} in Herdr`,
				});
		return { agents, ...(unavailable.length ? { unavailable } : {}) };
	},
	async spawn(params, deadline) {
		const machine = await machineEntry(params.machine);
		const profile = await loadProfile(params.agent_type.trim());
		if (machine && workerOfKind(profile.agent).localOnly) throw new Error(REMOTE_CLAUDE);
		const [context, target] = await Promise.all([
			controller(),
			onMachine(
				machine,
				"machine.target",
				{
					params,
					kind: profile.agent,
					...(machine ? {} : { fallbackCwd: params.fallbackCwd }),
				},
				deadline,
			),
		]);
		const [task, args] = await Promise.all([
			prepareMessage(profile, {
				cwd: target.cwd,
				message: params.message,
				base: params.base,
				local: !machine,
			}),
			profileArgs(profile),
		]);
		const { address } = await launch({
			params,
			agent: profile.agent,
			args,
			target,
			machine,
			existing: target.agents,
			controllerSpace: context.pane.workspace_id,
		});
		let delivery;
		try {
			delivery = await onMachine(
				machine,
				"machine.started",
				{
					address,
					kind: profile.agent,
					cwd: target.cwd,
					message: attribute(context, task, "task"),
				},
				deadline,
			);
		} catch (error) {
			try {
				await closeTerminal(machine ? `${machine.id}/${address}` : address);
			} catch (cleanup) {
				throw new Error(`${error.message}; closing its terminal also failed: ${cleanup.message}`);
			}
			throw error;
		}
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
