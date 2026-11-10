// Herdr Core JSON-RPC for the bridge. Inside a Core terminal the socket is
// HC_TERMINAL_SOCKET; elsewhere (a remote machine's `machine.exec`) the bridge
// speaks the same API through `hc connect` on stdin and stdout. One request
// per connection: Core dedicates a connection to events once it subscribes.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Core's file and exec methods return up to 8 MiB raw, base64 encoded.
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
// Core heartbeats every 15 s on a subscription.
const SUBSCRIPTION_IDLE_MS = 45_000;
const LOCAL_ADDRESS = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;

/** Labels this mod and pi-shepherdr publish on a worker's terminal. */
export const PI_SESSION_LABEL = "pi.session_file";
export const CLAUDE_SESSION_LABEL = "claude.session_id";

export function isLocalAddress(value) {
	return typeof value === "string" && LOCAL_ADDRESS.test(value);
}

/** This terminal's address, set only inside a Core terminal. */
export function ownTerminal() {
	const id = process.env.HC_TERMINAL_ID;
	return isLocalAddress(id) ? id : undefined;
}

export function hcBinary() {
	const configured = process.env.HC_BIN?.trim();
	if (configured) return configured;
	// hc installs its links in ~/.local/bin by default, which a noninteractive
	// environment may leave off PATH.
	const candidates = [
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
		join(homedir(), ".local", "bin"),
	].map((directory) => join(directory, "hc"));
	for (const path of candidates) {
		try {
			accessSync(path, constants.X_OK);
			return path;
		} catch {}
	}
	throw new Error("Herdr Core's hc is not installed on this machine");
}

/** A duplex to Core: the terminal's socket, or an `hc connect` child. */
function dial(onData, onEnd) {
	const socketPath = process.env.HC_TERMINAL_SOCKET;
	if (socketPath) {
		const socket = createConnection(socketPath);
		socket.setEncoding("utf8");
		socket.on("data", onData);
		socket.on("error", onEnd);
		socket.on("close", () => onEnd());
		return {
			ready: (send) => socket.on("connect", send),
			write: (text) => socket.write(text),
			destroy: () => socket.destroy(),
		};
	}
	const child = spawn(hcBinary(), ["connect"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", onData);
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	child.stdin.on("error", () => {});
	child.on("error", onEnd);
	child.on("close", (code) =>
		onEnd(
			code ? new Error(stderr.trim() || `hc connect exited ${code}`) : undefined,
		),
	);
	return {
		ready: (send) => send(),
		write: (text) => child.stdin.write(text),
		destroy: () => child.kill(),
	};
}

function rpcError(value) {
	const error = new Error(
		typeof value?.message === "string"
			? value.message
			: `Core request failed: ${JSON.stringify(value)}`,
	);
	if (typeof value?.data?.kind === "string") error.kind = value.data.kind;
	if (typeof value?.data?.hint === "string" && value.data.hint)
		error.hint = value.data.hint;
	error.coreResponse = true;
	return error;
}

/** Whether Core refused with this error kind (`not_found`, `blocked`, ...). */
export function isCoreError(error, kind) {
	return error?.coreResponse === true && error.kind === kind;
}

function open(label, method, params, onMessage, onEnd) {
	let buffer = "";
	let ended = false;
	let connection;
	const end = (error) => {
		if (ended) return;
		ended = true;
		connection?.destroy();
		onEnd(error ?? new Error(`${label} disconnected`));
	};
	try {
		connection = dial((chunk) => {
			if (ended) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
				return end(new Error(`${label} frame is too large`));
			for (
				let newline = buffer.indexOf("\n");
				newline >= 0 && !ended;
				newline = buffer.indexOf("\n")
			) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let value;
				try {
					value = JSON.parse(line);
				} catch {
					return end(new Error(`${label} returned invalid JSON`));
				}
				try {
					onMessage(value);
				} catch (error) {
					return end(error);
				}
			}
		}, end);
	} catch (error) {
		queueMicrotask(() => end(error));
		return end;
	}
	connection.ready(() =>
		connection.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
		),
	);
	return end;
}

function result(message, label) {
	if (message?.jsonrpc !== "2.0" || message.id !== 1)
		throw new Error(`${label} returned an invalid response`);
	if (message.error !== undefined) throw rpcError(message.error);
	return message.result;
}

export function request(method, params = {}, timeoutMs = 10_000) {
	const label = `Core ${method}`;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			close();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(
			() => finish(new Error(`${label} timed out`)),
			timeoutMs,
		);
		const close = open(
			label,
			method,
			params,
			(message) => {
				try {
					finish(undefined, result(message, label));
				} catch (error) {
					finish(error);
				}
			},
			(error) => finish(error),
		);
	});
}

/**
 * Subscribes to Core's events; resolves `{ terminals, close }` with the first
 * snapshot. `onChange(terminal?)` fires for each later event (its terminal's
 * address) and for a `missed` snapshot (no address: anything may have
 * changed). `onEnd(error)` reports a broken subscription, not `close()`.
 */
export function subscribe(filter, onChange, onEnd) {
	const label = "Core events.subscribe";
	return new Promise((resolve, reject) => {
		let started = false;
		let closing = false;
		let floor = 0;
		let idle;
		const arm = () => {
			clearTimeout(idle);
			idle = setTimeout(
				() => close(new Error(`${label} went silent`)),
				started ? SUBSCRIPTION_IDLE_MS : 10_000,
			);
		};
		arm();
		const close = open(
			label,
			"events.subscribe",
			filter,
			(message) => {
				if (!started) {
					const value = result(message, label);
					if (!Array.isArray(value?.terminals))
						throw new Error(`${label} returned no snapshot`);
					floor = value.seq ?? 0;
					started = true;
					arm();
					resolve({
						terminals: value.terminals,
						close: () => {
							closing = true;
							clearTimeout(idle);
							close();
						},
					});
					return;
				}
				arm();
				const params = message?.params;
				if (message?.method === "missed") {
					floor = params?.seq ?? floor;
					onChange(undefined);
				} else if (message?.method === "event") {
					if (typeof params?.seq === "number" && params.seq <= floor) return;
					onChange(typeof params?.terminal === "string" ? params.terminal : undefined);
				}
			},
			(error) => {
				clearTimeout(idle);
				if (!started) reject(error);
				else if (!closing) onEnd(error);
			},
		);
	});
}

/**
 * Pi and Claude Code report their status to Core themselves (OSC 7501, `app`
 * pi or claude-code); labels name their session. Labels outlive a kept
 * terminal's program, so they count only while that program reports.
 */
function workerSession(record) {
	if (record.state !== "live") return undefined;
	const app = record.status?.app;
	const labels = record.labels ?? {};
	if (app === "pi" && labels[PI_SESSION_LABEL])
		return { agent: "pi", kind: "path", value: labels[PI_SESSION_LABEL] };
	if (app === "claude-code")
		return labels[CLAUDE_SESSION_LABEL]
			? { agent: "claude", kind: "id", value: labels[CLAUDE_SESSION_LABEL] }
			: { agent: "claude" };
	return undefined;
}

const STATUSES = new Set(["idle", "working", "blocked", "done"]);

/**
 * The one agent shape the bridge reads, from a Core terminal record. The
 * address names the terminal for good: Core never moves or reuses it, so
 * pane_id and terminal_id are both the address.
 */
export function terminalAgent(record) {
	const address = record?.address;
	if (typeof address !== "string" || !address)
		throw new Error("Core returned a terminal without an address");
	const labels = record.labels ?? {};
	const session = workerSession(record);
	const state = record.status?.state;
	const live = record.state === "live";
	const foregroundCwd = record.foreground?.cwd;
	return {
		pane_id: address,
		terminal_id: address,
		agent: session?.agent ?? null,
		agent_status: state === "error" ? "done" : STATUSES.has(state) ? state : "unknown",
		...(state === "blocked" && record.status?.kind ? { blocked_kind: record.status.kind } : {}),
		live,
		interactive_ready: live && Boolean(session?.value),
		...(session?.value ? { agent_session: session } : {}),
		...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
		...(typeof foregroundCwd === "string" ? { foreground_cwd: foregroundCwd } : {}),
		...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
		...(typeof record.title === "string" && record.title ? { title: record.title } : {}),
		...(labels["herdr.space"] ? { workspace_id: labels["herdr.space"] } : {}),
		...(labels["herdr.tab"] ? { tab_id: labels["herdr.tab"] } : {}),
	};
}

/** A terminal by address or name; rejects with kind `not_found` when none. */
export async function getAgent(target) {
	return terminalAgent(await request("terminal.get", { terminal: target }));
}

/**
 * This machine's live terminals, as agents. The event snapshot, not
 * terminal.list, which waits on connected machines; remote ones are left out.
 */
export async function localAgents() {
	const { terminals, close } = await subscribe({}, () => {}, () => {});
	close();
	return terminals
		.filter((record) => record.state === "live" && isLocalAddress(record.address))
		.map(terminalAgent);
}

/** This Core's stable identity and display name. */
export async function coreIdentity() {
	const hello = await request("hello", {});
	const core = hello?.core;
	if (typeof core?.id !== "string" || !core.id)
		throw new Error("Core returned no identity; update Herdr Core");
	return { id: core.id, name: typeof core.name === "string" ? core.name : core.id };
}

/** The one agent shape the mod reads. */
export function agentSummary(agent) {
	const cwd = agent.foreground_cwd || agent.cwd;
	return {
		target: agent.pane_id,
		...(agent.name ? { name: agent.name } : {}),
		kind: agent.agent,
		status: agent.agent_status,
		terminal: agent.terminal_id,
		...(cwd ? { cwd } : {}),
	};
}

/** Kills a live terminal, then removes it; refuses one whose state is unknown. */
export async function closeTerminal(address) {
	const record = await request("terminal.get", { terminal: address });
	if (record.state === "live")
		await request("terminal.kill", { terminal: address }, 15_000);
	else if (record.state !== "finished")
		throw new Error(`${address} is in an unknown state; inspect it before closing`);
	await request("terminal.rm", { terminal: address });
}

/** Terminal identity for pi-shepherdr's peer protocol, through this machine's Core. */
export const terminalPeer = { terminal: getAgent, closeTerminal };
