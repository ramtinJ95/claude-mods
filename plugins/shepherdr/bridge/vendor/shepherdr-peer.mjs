// Delivery to a Pi worker's Shepherdr receiver, from pi-shepherdr's peer
// protocol. The receiver publishes a descriptor (port and token) beside its
// session file; frames carry the message, its sender and task guidance.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

const MAX_PEER_FRAME_BYTES = 8 * 1024 * 1024;
export const PEER_PROTOCOL = 4;

/** @param {string} sessionFile @param {string} terminalId */
export function peerInboxPath(sessionFile, terminalId) {
	const terminal = createHash("sha256")
		.update(terminalId)
		.digest("hex")
		.slice(0, 16);
	return `${sessionFile}.shepherdr-${terminal}.json`;
}

/** @param {string} message @param {boolean} rejected */
function deliveryError(message, rejected) {
	return Object.assign(new Error(message), {
		code: rejected
			? "SHEPHERDR_DELIVERY_REJECTED"
			: "SHEPHERDR_DELIVERY_UNKNOWN",
	});
}

/**
 * Sends one message frame. Resolves undefined when the worker publishes no
 * receiver, so the caller can choose another route.
 * @param {(method: string, params: object) => Promise<any>} request
 * @param {{ pane_id: string, terminal_id: string, agent_session?: { kind: string, value: string } | null }} expected
 * @param {{ text: string, sender: string, context?: string }} message
 * @param {{ commands?: boolean }} [options] commands asks for the slash
 *   commands the worker accepts instead of delivering text; it works while blocked.
 * @returns {Promise<{ command: boolean, commands?: { name: string, description: string }[] } | undefined>}
 */
export async function sendPeerMessage(request, expected, message, options = {}) {
	const { agent } = await request("agent.get", { target: expected.pane_id });
	const session = agent?.agent_session;
	const sessionFile = session?.kind === "path" ? session.value : undefined;
	if (
		agent?.agent !== "pi" ||
		agent.terminal_id !== expected.terminal_id ||
		!sessionFile ||
		(expected.agent_session?.kind === "path" &&
			expected.agent_session.value !== sessionFile)
	)
		throw deliveryError(
			"Target Pi session changed or is not ready; resolve the target again",
			true,
		);
	if (!options.commands && agent.agent_status === "blocked")
		throw deliveryError(
			"Target is blocked; answer its pending question first",
			true,
		);
	let raw;
	try {
		raw = await readFile(peerInboxPath(sessionFile, agent.terminal_id), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw deliveryError(
			`Could not read target Shepherdr receiver: ${error.message}`,
			true,
		);
	}
	const descriptor = JSON.parse(raw);
	if (
		descriptor?.protocol !== PEER_PROTOCOL ||
		!Number.isInteger(descriptor.port) ||
		descriptor.port < 1 ||
		descriptor.port > 65535 ||
		typeof descriptor.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(descriptor.token)
	)
		throw deliveryError(
			"Target Shepherdr receiver is invalid; reload the target Pi session",
			true,
		);
	const id = randomUUID();
	const frame = `${JSON.stringify({
		protocol: PEER_PROTOCOL,
		kind: options.commands ? "commands" : "message",
		id,
		token: descriptor.token,
		sessionFile,
		terminalId: agent.terminal_id,
		text: message.text,
		sender: message.sender,
		context: message.context,
	})}\n`;
	if (Buffer.byteLength(frame) > MAX_PEER_FRAME_BYTES)
		throw deliveryError("Peer message is too large", true);
	return deliverFrame(request, expected, message, descriptor.port, sessionFile, id, frame);
}

function deliverFrame(request, expected, message, port, sessionFile, id, frame) {
	return new Promise((resolve, reject) => {
		let attempted = false;
		let settled = false;
		let buffer = "";
		let closing = false;
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (error, receipt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(receipt);
		};
		const failed = () =>
			finish(
				deliveryError(
					attempted
						? "Peer delivery was not acknowledged; inspect the target before retrying"
						: "Target Shepherdr receiver is unavailable; reload the target Pi session",
					!attempted,
				),
			);
		const timer = setTimeout(failed, 10_000);
		timer.unref();
		socket.setEncoding("utf8");
		socket.on("error", failed);
		socket.on("end", () => {
			if (settled) return;
			if (!closing) return failed();
			void closeExitedPane(request, expected, sessionFile).then(
				() => finish(undefined, { command: true }),
				(error) =>
					finish(
						deliveryError(
							`Pi shut down, but its pane could not be closed: ${error.message}`,
							false,
						),
					),
			);
		});
		socket.on("close", () => {
			if (!closing) failed();
		});
		socket.on("connect", () => {
			attempted = true;
			socket.write(frame);
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_PEER_FRAME_BYTES) return failed();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const reply = JSON.parse(buffer.slice(0, newline));
				if (reply.protocol !== PEER_PROTOCOL || reply.id !== id)
					return failed();
				if (reply.ok === true && typeof reply.command === "boolean") {
					if (
						reply.closing === true &&
						reply.command &&
						message.text.trim() === "/quit"
					) {
						closing = true;
						// The receiver retains this socket through session_shutdown.
						// Only process exit ends it; never close a pane on a timeout.
						clearTimeout(timer);
					} else
						finish(undefined, {
							command: reply.command,
							...(Array.isArray(reply.commands)
								? {
										commands: reply.commands
											.filter(
												(entry) =>
													typeof entry?.name === "string" &&
													typeof entry.description === "string",
											)
											.map(({ name, description }) => ({ name, description })),
									}
								: {}),
						});
				} else if (reply.ok === false && typeof reply.error === "string")
					finish(deliveryError(reply.error, reply.rejected === true));
				else failed();
			} catch {
				failed();
			}
		});
	});
}

/** Closes an exited worker's pane, refusing when another terminal or session holds it now. */
export async function closeExitedPane(request, expected, sessionFile) {
	const { pane } = await request("pane.current", {
		caller_pane_id: expected.pane_id,
	});
	if (typeof pane?.pane_id !== "string" || pane.terminal_id !== expected.terminal_id)
		throw new Error("Target pane changed; resolve it again");
	if (pane.agent_session?.value && pane.agent_session.value !== sessionFile)
		throw new Error("Target session changed; resolve it again");
	await request("pane.close", { pane_id: pane.pane_id });
}
