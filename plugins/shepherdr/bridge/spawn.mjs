// Starts a Pi or Claude Code worker in a new Herdr tab, workspace or existing
// pane on the machine this runs on.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgent, isHerdrErrorCode, request, snapshot } from "./herdr.mjs";
import { workerFor, workerOfKind } from "./workers/index.mjs";

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

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

function allocateName(agents, label, requested) {
	const names = new Set(agents.map((agent) => agent.name).filter(Boolean));
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

function resolveWorkspace(workspaces, target) {
	const direct = workspaces.find((item) => item.workspace_id === target);
	if (direct) return direct;
	const matches = workspaces.filter((item) => item.label === target);
	if (matches.length === 1) return matches[0];
	throw new Error(
		matches.length
			? `workspace label ${target} is ambiguous; use its Herdr ID`
			: `no Herdr workspace matches ${target}`,
	);
}

/**
 * A new tab goes to `workspace` or the controller's own workspace; on a remote
 * machine there is none, so a spawn without `workspace` gets a new workspace.
 */
async function createLocation(params, cwd, label, workspaces, controllerWorkspace) {
	const placement =
		params.placement ??
		(params.workspace || controllerWorkspace ? "new_tab" : "new_workspace");
	if (placement === "pane") return { paneId: params.pane };
	if (placement === "new_tab") {
		const workspaceId = params.workspace
			? resolveWorkspace(workspaces, params.workspace).workspace_id
			: controllerWorkspace;
		if (!workspaceId)
			throw new Error("a new tab on another machine needs workspace");
		const created = await request("tab.create", {
			workspace_id: workspaceId,
			cwd,
			label,
			focus: false,
		});
		return {
			paneId: created.root_pane.pane_id,
			cleanup: { method: "tab.close", params: { tab_id: created.tab.tab_id } },
		};
	}
	if (placement !== "new_workspace")
		throw new Error("placement must be new_tab, new_workspace or pane");
	const created = await request("workspace.create", { cwd, focus: false });
	const cleanup = {
		method: "workspace.close",
		params: { workspace_id: created.workspace.workspace_id },
	};
	try {
		await request("tab.rename", { tab_id: created.tab.tab_id, label });
	} catch (error) {
		await rollback(cleanup, error);
	}
	return { paneId: created.root_pane.pane_id, cleanup };
}

async function rollback(cleanup, cause) {
	if (!cleanup) throw cause;
	try {
		await request(cleanup.method, cleanup.params);
	} catch (cleanupError) {
		throw new Error(
			`${cause.message}; rollback also failed: ${cleanupError.message}`,
		);
	}
	throw cause;
}

async function startWhenShellReady(params) {
	const shellDeadline = Date.now() + 3_000;
	let started;
	for (;;) {
		try {
			started = (await request("agent.start", params, 35_000)).agent;
			break;
		} catch (error) {
			if (
				!isHerdrErrorCode(error, "agent_pane_busy") ||
				Date.now() >= shellDeadline
			)
				throw error;
			await sleep(50);
		}
	}
	// Herdr can finish launch before Pi reports its persistent session.
	const readyDeadline = Date.now() + 30_000;
	while (Date.now() < readyDeadline) {
		let current;
		try {
			current = await getAgent(params.name);
		} catch (error) {
			if (!isHerdrErrorCode(error, "agent_not_found")) throw error;
			await sleep(100);
			continue;
		}
		if (current.terminal_id !== started.terminal_id)
			throw new Error(`named agent ${params.name} no longer owns its pane`);
		if (current.agent_status === "blocked")
			throw new Error(`agent ${params.name} is blocked during startup`);
		const settled =
			current.agent_status === "idle" || current.agent_status === "done";
		if (settled && current.interactive_ready === true && current.agent) {
			if (workerFor(current).isReady(current)) return current;
		} else if (settled && current.launch_pending === false)
			throw new Error("agent process exited before becoming interactive");
		await sleep(100);
	}
	throw new Error(`timed out waiting for agent ${params.name} to become ready`);
}

/**
 * The worker's directory, resolved on its machine before launch so the
 * profile's preparation runs first. Relative paths start at `fallbackCwd`
 * locally and at the home directory on a remote machine.
 */
export async function spawnDirectory(params, fallbackCwd = homedir()) {
	if (params.placement !== "pane")
		return directory(resolve(fallbackCwd, params.cwd?.trim() || "."));
	if (!params.pane) throw new Error("pane is required for placement=pane");
	if (params.cwd)
		throw new Error("cwd cannot change an existing pane; omit cwd");
	const { pane } = await request("pane.get", { pane_id: params.pane });
	return pane.foreground_cwd || pane.cwd || fallbackCwd;
}

/** A start that stalls at the folder trust prompt says so: trusting a folder is the user's decision. */
async function startupError(paneId, cwd, program, error) {
	let screen;
	try {
		screen = (
			await request("pane.read", {
				pane_id: paneId,
				source: "visible",
				lines: 40,
				strip_ansi: true,
			})
		).read?.text;
	} catch {
		return error;
	}
	if (!/\btrust\b/i.test(screen ?? "")) return error;
	return new Error(
		`${program} stopped at its folder trust prompt for ${cwd}; ask the user to trust that folder in ${program}, or choose a trusted cwd`,
	);
}

/**
 * Starts the profile's agent on this machine with the controller's profile
 * arguments. `controllerWorkspace` is set only when the controller runs here.
 * Returns `{ agent, notice? }`, the notice from the adapter's `awaitStartup`.
 */
export async function startAgent({ params, agent, args: profile, cwd, controllerWorkspace }) {
	const label = params.label.trim();
	const { agents, workspaces } = await snapshot();
	const name = allocateName(agents, label, params.name);
	const worker = workerOfKind(agent);
	const args = worker.launchArgs(label, profile);
	const location = await createLocation(params, cwd, label, workspaces, controllerWorkspace);
	try {
		const started = await startWhenShellReady({
			name,
			kind: agent,
			pane_id: location.paneId,
			args,
			timeout_ms: 30_000,
		});
		const startup = await worker.awaitStartup?.(started);
		return { agent: started, ...(startup?.notice ? { notice: startup.notice } : {}) };
	} catch (error) {
		return rollback(
			location.cleanup,
			await startupError(location.paneId, cwd, worker.program, error),
		);
	}
}
