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
	isCoreError,
	localAgents,
	ownTerminal,
	request,
} from "./core.mjs";
import { catalog, remoteCall, resolveMachine } from "./machines.mjs";
import {
	initialProfile,
	listProfiles,
	loadProfile,
	onModel,
	prepareMessage,
	profileArgs,
	startsFreshSession,
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
	/**
	 * Waits for a launched worker, then delivers its message: a spawn's first
	 * task, or what reopened a saved `session`. `saved` names the session a
	 * later resume reopens.
	 */
	async "machine.started"({ address, kind, cwd, message, messageKind = "task", session }) {
		const agent = await awaitWorker(address, kind, cwd);
		const saved = workerOfKind(kind).savedSession(agent);
		if (session !== undefined && saved !== session)
			throw new Error(
				"the reopened worker did not open its saved session; open that session yourself before retrying",
			);
		return { ...(await deliver(agent.terminal_id, message, messageKind)), saved };
	},
	/**
	 * Where a spawned worker (`terminalId`, `launch`) is now: `live` names the
	 * terminal to deliver to, when its own still runs, another hosts its
	 * session, or a live terminal answers to `target`. Otherwise the directory,
	 * program and names a relaunch needs.
	 */
	async "machine.revive"({ terminalId, launch: saved, target }) {
		const agents = await localAgents();
		if (agents.some((agent) => agent.terminal_id === terminalId)) return { live: terminalId };
		const worker = workerOfKind(saved.kind);
		const hosting = agents.filter(
			(agent) => agent.agent === saved.kind && worker.savedSession(agent) === saved.session,
		);
		if (hosting.length > 1)
			throw new Error(
				`the worker's session is open in ${hosting.map((agent) => agent.pane_id).join(" and ")}; close the extra one before sending`,
			);
		if (hosting[0]) return { live: hosting[0].terminal_id };
		// A live terminal now answering to that address or name is not this worker.
		if (agents.some((agent) => agent.pane_id === target || agent.name === target))
			return { live: target };
		return {
			...(await launchTarget({ cwd: saved.cwd }, saved.kind)),
			agents: agents.map(({ name, workspace_id }) => ({
				...(name ? { name } : {}),
				...(workspace_id ? { workspace_id } : {}),
			})),
		};
	},
	/**
	 * Closes each spawned worker that is idle on the session it was spawned
	 * with; the adapter decides idleness. Workers already gone are left out.
	 */
	"machine.closeIdle"({ children }) {
		return Promise.all(
			children.map(async ({ terminalId, launch: saved }) => {
				try {
					const agent = await getAgent(terminalId);
					if (!agent.live) return { terminalId, gone: true };
					const worker = workerOfKind(saved.kind);
					if (agent.agent !== saved.kind || worker.savedSession(agent) !== saved.session)
						return { terminalId, skipped: "runs another session" };
					await worker.closeIfIdle(agent);
					return { terminalId, closed: true };
				} catch (error) {
					return isCoreError(error, "not_found")
						? { terminalId, gone: true }
						: { terminalId, skipped: error.message };
				}
			}),
		);
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
		const [record, { status, session }] = await Promise.all([
			recordFor(agent, worker, true),
			worker.answer(agent, askId, answers),
		]);
		return {
			agent: agentSummary(agent),
			...(session ? { session } : { status: status ?? "unknown" }),
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

/**
 * A message as its worker reads it. `profile` is a Pi profile's prompt, which
 * briefs the first task only, as pi-shepherdr's own controller does.
 */
function attribute({ pane, core }, text, kind, profile) {
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
	const context = [
		...(profile ? [`<initial_worker_profile>\n${profile}\n</initial_worker_profile>`] : []),
		...(kind === "task" ? [DELEGATED_WORKER_GUIDANCE] : []),
	].join("\n\n");
	return {
		sender: `<herdr_sender ${attributes} />`,
		text,
		...(context ? { context } : {}),
	};
}

/**
 * Hands a launched worker its message on its own machine; a worker that never
 * took it is closed again, so a failed launch leaves nothing behind.
 */
async function started(machine, address, params, deadline) {
	try {
		return await onMachine(machine, "machine.started", { address, ...params }, deadline);
	} catch (error) {
		try {
			await closeTerminal(machine ? `${machine.id}/${address}` : address);
		} catch (cleanup) {
			throw new Error(`${error.message}; closing its terminal also failed: ${cleanup.message}`);
		}
		throw error;
	}
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
		const profile = onModel(await loadProfile(params.agent_type.trim()), params.model?.trim());
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
		const [task, args, prompt] = await Promise.all([
			prepareMessage(profile, {
				cwd: target.cwd,
				message: params.message,
				base: params.base,
				local: !machine,
			}),
			profileArgs(profile),
			initialProfile(profile),
		]);
		const { address } = await launch({
			params,
			agent: profile.agent,
			argv: workerOfKind(profile.agent).launchArgs(params.label.trim(), args),
			target,
			machine,
			existing: target.agents,
			controllerSpace: context.pane.workspace_id,
		});
		const { saved, ...delivery } = await started(
			machine,
			address,
			{ kind: profile.agent, cwd: target.cwd, message: attribute(context, task, "task", prompt) },
			deadline,
		);
		return {
			...delivery,
			...(profile.blocking === undefined
				? {}
				: { profileBlocking: profile.blocking }),
			// What reopens this worker once it has closed; a profile that
			// opened an existing session did not make it this controller's.
			...(saved && startsFreshSession(profile)
				? { launch: { kind: profile.agent, session: saved, cwd: target.cwd, args } }
				: {}),
		};
	},
	/**
	 * Delivers to a live agent. `child` is the target as a worker this
	 * controller spawned: once closed it is reopened on its saved session
	 * first, except for `/quit`.
	 */
	async deliver({ machine, target, message, kind, child }, deadline) {
		const [entry, context] = await Promise.all([
			machineEntry(machine),
			controller(),
		]);
		const attributed = attribute(context, message, kind);
		const send = (to) =>
			onMachine(entry, "machine.deliver", { target: to, message: attributed, kind }, deadline);
		if (!child) return send(target);
		const state = await onMachine(entry, "machine.revive", { ...child, target }, deadline);
		if (state.live) return send(state.live);
		if (/^\/quit\s*$/.test(message.trim()))
			throw new Error(`${target} is already closed; nothing was resumed`);
		const saved = child.launch;
		const worker = workerOfKind(saved.kind);
		if (entry && worker.localOnly) throw new Error(REMOTE_CLAUDE);
		const { address } = await launch({
			params: { label: child.name ?? "worker" },
			agent: saved.kind,
			argv: worker.resumeArgs(saved.args, saved.session),
			target: state,
			machine: entry,
			existing: state.agents,
			controllerSpace: context.pane.workspace_id,
		});
		const { saved: _session, ...delivery } = await started(
			entry,
			address,
			{ kind: saved.kind, cwd: state.cwd, message: attributed, messageKind: kind, session: saved.session },
			deadline,
		);
		return { ...delivery, resumed: true };
	},
	/** Closes the idle ones among `children`, workers this controller spawned, machine by machine. */
	async closeIdle({ children }, deadline) {
		const machines = [...new Set(children.map((child) => child.machine))];
		const results = await Promise.all(
			machines.map(async (machine) => {
				const own = children.filter((child) => child.machine === machine);
				try {
					const closed = await onMachine(
						await machineEntry(machine),
						"machine.closeIdle",
						{ children: own },
						deadline,
					);
					return closed.map((result) => ({ ...result, ...(machine ? { machine } : {}) }));
				} catch (error) {
					return own.map(({ terminalId }) => ({ terminalId, machine, skipped: error.message }));
				}
			}),
		);
		return results.flat();
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
