// Starts a Pi or Claude Code worker in a new Core terminal. The controller's
// Core runs the terminal (with `on` for another machine), so it is the
// controller's child and a Herdr window adopts it; the worker's machine
// resolves its directory and program and waits for it to become ready.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { getAgent, ownTerminal, request, subscribe } from "./core.mjs";
import { workerFor, workerOfKind } from "./workers/index.mjs";

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const READY_TIMEOUT_MS = 30_000;

function slugify(value) {
	const slug = value
		.normalize("NFKD")
		.replace(/[̀-ͯ]/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	const named = /^[a-z]/u.test(slug) ? slug : `agent-${slug}`;
	return named.slice(0, 32).replace(/-+$/u, "") || "agent";
}

/** A terminal name free among `names`, which Core requires unique among a machine's live terminals. */
export function allocateName(names, label, requested) {
	if (requested) {
		if (!AGENT_NAME.test(requested))
			throw new Error(
				"name must be 1–32 characters, start with a lowercase letter, and contain only lowercase letters, digits, underscores or hyphens. Omit name to generate it from label; label can be longer.",
			);
		if (names.has(requested))
			throw new Error(`agent name ${requested} is already live`);
		return requested;
	}
	const base = slugify(label);
	if (!names.has(base)) return base;
	for (let suffix = 2; suffix < 10_000; suffix += 1) {
		const tail = `-${suffix}`;
		const candidate = `${base.slice(0, 32 - tail.length).replace(/-+$/u, "")}${tail}`;
		if (!names.has(candidate)) return candidate;
	}
	throw new Error(`could not allocate an agent name for ${label}`);
}

async function directory(path) {
	const metadata = await stat(path).catch((error) => {
		throw new Error(`cannot use working directory ${path}: ${error.message}`);
	});
	if (!metadata.isDirectory()) throw new Error(`${path} is not a directory`);
	return path;
}

/**
 * The program's absolute path on this machine: Core would take a bare name
 * that matches one of its templates for that template.
 */
async function executable(name) {
	for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const path = resolve(folder, name);
		try {
			if (!(await stat(path)).isFile()) continue;
			await access(path, constants.X_OK);
			return path;
		} catch (error) {
			if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
		}
	}
	throw new Error(`${name} is not on PATH on that machine; install it before spawning`);
}

/**
 * The worker's directory and program, resolved on its machine before launch so
 * the profile's preparation runs first. Relative paths start at `fallbackCwd`
 * locally and at the home directory on a remote machine.
 */
export async function launchTarget(params, kind, fallbackCwd = homedir()) {
	const [cwd, program] = await Promise.all([
		directory(resolve(fallbackCwd, params.cwd?.trim() || ".")),
		executable(workerOfKind(kind).executable),
	]);
	return { cwd, program };
}

const newId = (prefix) => `${prefix}${randomUUID().replaceAll("-", "")}`;

/**
 * Herdr-window placement labels. A tab joins a space a live terminal on the
 * same Core advertises; without one the worker runs as a background terminal,
 * which the window lists but does not lay out.
 */
function placementLabels(params, spaces, controllerSpace) {
	const placement =
		params.placement ?? (params.workspace || controllerSpace ? "new_tab" : "terminal");
	if (placement === "terminal") return {};
	if (placement === "new_workspace")
		return { "herdr.space": newId("sp"), "herdr.tab": newId("tb") };
	if (placement !== "new_tab")
		throw new Error("placement must be terminal, new_tab or new_workspace");
	const space = params.workspace ?? controllerSpace;
	if (!space) throw new Error("a new tab on another machine needs workspace");
	if (!spaces.has(space))
		throw new Error(
			`no live terminal on that machine is in Herdr space ${space}; use a workspace from list, or placement new_workspace`,
		);
	return { "herdr.space": space, "herdr.tab": newId("tb") };
}

/**
 * Runs the worker's terminal through this machine's Core: on `machine` (a
 * Core machine entry) or here. `existing` are the target machine's live
 * agents. Returns the terminal's address on its own machine.
 */
export async function launch({ params, agent, args, target, machine, existing, controllerSpace }) {
	const label = params.label.trim();
	const name = allocateName(
		new Set(existing.map((item) => item.name).filter(Boolean)),
		label,
		params.name,
	);
	const worker = workerOfKind(agent);
	const spaces = new Set(existing.map((item) => item.workspace_id).filter(Boolean));
	const caller = ownTerminal();
	const started = await request(
		"terminal.run",
		{
			argv: [target.program, ...worker.launchArgs(label, args)],
			name,
			cwd: target.cwd,
			...(machine ? { on: machine.id } : {}),
			...(caller ? { caller } : {}),
			// Workers report through Shepherdr, not Core's notes to their parent.
			no_notify: true,
			// Workers keep running when the controller exits, as they did in
			// Herdr tabs; /quit or the user closes them.
			outlive_parent: true,
			labels: {
				...placementLabels(params, spaces, machine ? undefined : controllerSpace),
				...(worker.launchLabels?.(args) ?? {}),
			},
		},
		30_000,
	);
	const address = typeof started?.address === "string" ? started.address.split("/").at(-1) : undefined;
	if (!address)
		throw new Error(
			"Core returned no terminal address for the launch; inspect its terminals before retrying",
		);
	return { address, name };
}

/** Resolves once the worker's terminal hosts a ready worker; rejects when it exits or blocks. */
async function ready(address) {
	return new Promise((resolve, reject) => {
		let done = false;
		let subscription;
		const finish = (error, agent) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			subscription?.close();
			if (error) reject(error);
			else resolve(agent);
		};
		const timer = setTimeout(
			() => finish(new Error(`timed out waiting for ${address} to become ready`)),
			READY_TIMEOUT_MS,
		);
		let chain = Promise.resolve();
		const inspect = () => {
			chain = chain
				.then(async () => {
					if (done) return;
					const agent = await getAgent(address);
					if (!agent.live)
						throw new Error("agent process exited before becoming interactive");
					if (agent.agent_status === "blocked")
						throw new Error(`${address} is blocked during startup`);
					const settled =
						agent.agent_status === "idle" || agent.agent_status === "done";
					if (settled && agent.agent && workerFor(agent).isReady(agent))
						finish(undefined, agent);
				})
				.catch((error) => finish(error));
		};
		subscribe({ terminal: address }, inspect, (error) => finish(error)).then(
			(opened) => {
				subscription = opened;
				if (done) opened.close();
				else inspect();
			},
			(error) => finish(error),
		);
	});
}

/**
 * A start that stalls at the folder trust prompt says so: trusting a folder is
 * the user's decision. The adapter's `startupFailure` explains other screens.
 */
async function startupError(address, cwd, worker, error) {
	let screen;
	try {
		screen = (await request("terminal.read", { terminal: address, lines: 0 })).text;
	} catch {
		return error;
	}
	const failure = worker.startupFailure?.(screen ?? "");
	if (failure) return new Error(failure);
	if (!/\btrust\b/i.test(screen ?? "")) return error;
	return new Error(
		`${worker.program} stopped at its folder trust prompt for ${cwd}; ask the user to trust that folder in ${worker.program}, or choose a trusted cwd`,
	);
}

/**
 * Waits on this machine for a launched worker to become ready, then for the
 * adapter's `awaitStartup`. Returns `{ agent, notice? }`; a failure is
 * explained from the worker's screen, for the controller to roll back.
 */
export async function awaitWorker(address, kind, cwd) {
	const worker = workerOfKind(kind);
	try {
		const agent = await ready(address);
		const startup = await worker.awaitStartup?.(agent);
		return { agent, ...(startup?.notice ? { notice: startup.notice } : {}) };
	} catch (error) {
		throw await startupError(address, cwd, worker, error);
	}
}
