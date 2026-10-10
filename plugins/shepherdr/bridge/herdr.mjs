// Herdr socket JSON-RPC for the Claude Code controller bridge.
import { createConnection } from "node:net";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function socketPath() {
	const path = process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_ENV !== "1" || !path)
		throw new Error("Claude Code is not running inside Herdr");
	return path;
}

function responseError(value) {
	const error = new Error(
		typeof value?.message === "string"
			? value.message
			: `Herdr request failed: ${JSON.stringify(value)}`,
	);
	if (typeof value?.code === "string") error.code = value.code;
	error.herdrResponse = true;
	return error;
}

export function isHerdrErrorCode(error, code) {
	return error?.herdrResponse === true && error.code === code;
}

function open(label, message, onValue, onEnd) {
	let buffer = "";
	let ended = false;
	const socket = createConnection(socketPath());
	const end = (error) => {
		if (ended) return;
		ended = true;
		socket.destroy();
		onEnd(error ?? new Error(`${label} disconnected`));
	};
	socket.setEncoding("utf8");
	socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
	socket.on("error", end);
	socket.on("close", () => end());
	socket.on("data", (chunk) => {
		buffer += chunk;
		if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
			return end(new Error(`${label} frame is too large`));
		for (
			let newline = buffer.indexOf("\n");
			newline >= 0;
			newline = buffer.indexOf("\n")
		) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let value;
			try {
				value = JSON.parse(line);
			} catch {
				return end(new Error(`${label} returned invalid JSON`));
			}
			onValue(value);
		}
	});
	return end;
}

export function request(method, params = {}, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const id = `claude-shepherdr:${crypto.randomUUID()}`;
		let settled = false;
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			close();
			if (error) reject(error);
			else resolve(result);
		};
		const timer = setTimeout(
			() => finish(new Error(`Herdr ${method} timed out`)),
			timeoutMs,
		);
		const close = open(
			`Herdr ${method}`,
			{ id, method, params },
			(response) => {
				if (response.id !== id)
					finish(new Error(`Herdr ${method} returned a mismatched response`));
				else if (response.error !== undefined)
					finish(responseError(response.error));
				else finish(undefined, response.result);
			},
			(error) => finish(error),
		);
	});
}

/** Resolves a close function once Herdr acknowledges the subscription. */
export function subscribe(subscriptions, onEvent, onEnd) {
	return new Promise((resolve, reject) => {
		const id = `claude-shepherdr:subscribe:${crypto.randomUUID()}`;
		let started = false;
		let closing = false;
		const timer = setTimeout(
			() => close(new Error("Herdr events.subscribe timed out")),
			10_000,
		);
		const close = open(
			"Herdr events.subscribe",
			{ id, method: "events.subscribe", params: { subscriptions } },
			(value) => {
				if (!started) {
					if (value.id !== id) return;
					if (value.error !== undefined)
						return close(responseError(value.error));
					if (value.result?.type !== "subscription_started")
						return close(
							new Error(
								"Herdr events.subscribe returned an invalid acknowledgement",
							),
						);
					started = true;
					clearTimeout(timer);
					resolve(() => {
						closing = true;
						close();
					});
					return;
				}
				if (typeof value.event === "string" && value.data)
					onEvent(value.event, value.data);
			},
			(error) => {
				clearTimeout(timer);
				if (!started) reject(error);
				else if (!closing) onEnd(error);
			},
		);
	});
}

export async function getAgent(target) {
	const result = await request("agent.get", { target });
	return result.agent;
}

export async function snapshot() {
	const result = await request("session.snapshot", {});
	return result.snapshot;
}

/** The events that can change a worker's settlement; the watcher and blocking waits share them. */
export function workerSubscriptions(paneIds) {
	return [
		...paneIds.map((paneId) => ({
			type: "pane.agent_status_changed",
			pane_id: paneId,
		})),
		{ type: "pane.closed" },
		{ type: "pane.moved" },
	];
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

/** Pane IDs change on move; the terminal identifies the occupant. */
export function agentByTerminal(agents, terminalId) {
	return agents.find((agent) => agent.terminal_id === terminalId);
}

export async function currentPane() {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) throw new Error("HERDR_PANE_ID is unset");
	const result = await request("pane.current", { caller_pane_id: paneId });
	return result.pane;
}
