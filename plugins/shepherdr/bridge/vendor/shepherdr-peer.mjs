// Delivery to a Pi worker's Shepherdr receiver, from pi-shepherdr's peer
// protocol. The receiver publishes a descriptor (port and token) beside its
// session file; frames carry the message, its sender and task guidance.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";

const MAX_PEER_FRAME_BYTES = 8 * 1024 * 1024;
export const PEER_PROTOCOL = 4;
// The receiver gives an extension a minute to act on a reply.
const EXTENSION_REPLY_TIMEOUT_MS = 60_000;

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
 * The worker's Shepherdr receiver: its descriptor and session file, after
 * checking the pane still hosts the expected Pi session. A worker that
 * publishes none is an error: nothing is typed into its terminal instead.
 */
async function resolveReceiver(peer, expected, { allowBlocked }) {
	const agent = await peer.terminal(expected.terminal_id);
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
	if (!allowBlocked && agent.agent_status === "blocked")
		throw deliveryError(
			"Target is blocked; answer its pending question first",
			true,
		);
	let raw;
	try {
		raw = await readFile(peerInboxPath(sessionFile, agent.terminal_id), "utf8");
	} catch (error) {
		if (error.code === "ENOENT")
			throw deliveryError(
				`${agent.pane_id} has no Shepherdr receiver; install or update @howaboua/pi-shepherdr in that Pi, or reload it`,
				true,
			);
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
	return { descriptor, sessionFile, terminalId: agent.terminal_id };
}

/** A frame for `receiver` under a fresh request ID. */
function peerFrame(receiver, fields) {
	const id = randomUUID();
	const frame = `${JSON.stringify({
		protocol: PEER_PROTOCOL,
		id,
		token: receiver.descriptor.token,
		sessionFile: receiver.sessionFile,
		terminalId: receiver.terminalId,
		...fields,
	})}\n`;
	if (Buffer.byteLength(frame) > MAX_PEER_FRAME_BYTES)
		throw deliveryError("Peer message is too large", true);
	return { id, frame };
}

/**
 * Sends one message frame.
 * @param {{ terminal(address: string): Promise<object>, closeTerminal(address: string): Promise<void> }} peer Core identity of the worker's terminal
 * @param {{ pane_id: string, terminal_id: string, agent_session?: { kind: string, value: string } | null }} expected
 * @param {{ text: string, sender: string, context?: string }} message
 * @param {{ commands?: boolean, closeIfIdle?: boolean }} [options] commands
 *   asks for the slash commands the worker accepts instead of delivering text;
 *   it works while blocked. closeIfIdle sends `/quit` for the receiver to run
 *   only if the worker is idle at that moment, rejecting otherwise.
 * @returns {Promise<{ command: boolean, closed?: true, commands?: { name: string, description: string }[] }>}
 *   closed: Pi quit and its terminal was closed
 */
export async function sendPeerMessage(peer, expected, message, options = {}) {
	const receiver = await resolveReceiver(peer, expected, {
		allowBlocked: options.commands === true,
	});
	const { id, frame } = peerFrame(receiver, {
		kind: options.closeIfIdle ? "close-idle" : options.commands ? "commands" : "message",
		text: message.text,
		sender: message.sender,
		context: message.context,
	});
	return deliverFrame(peer, expected, message, receiver.descriptor.port, receiver.sessionFile, id, frame);
}

/**
 * Hands a reply to the extension that published a pending extension message
 * (`shepherdr-extension-message`). It reaches a blocked worker without a
 * turn and resolves once the extension accepted it; a refusal rejects with
 * its reason.
 * @param {{ extension: string, id: string, message: string }} reply
 */
export async function sendPeerExtensionReply(peer, expected, reply) {
	const receiver = await resolveReceiver(peer, expected, { allowBlocked: true });
	const { id, frame } = peerFrame(receiver, {
		kind: "extension-reply",
		extension: reply.extension,
		messageId: reply.id,
		message: reply.message,
	});
	await deliverFrame(peer, expected, { text: "" }, receiver.descriptor.port, receiver.sessionFile, id, frame, EXTENSION_REPLY_TIMEOUT_MS);
}

function deliverFrame(peer, expected, message, port, sessionFile, id, frame, timeoutMs = 10_000) {
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
		const timer = setTimeout(failed, timeoutMs);
		timer.unref();
		socket.setEncoding("utf8");
		socket.on("error", failed);
		socket.on("end", () => {
			if (settled) return;
			if (!closing) return failed();
			void closeExitedTerminal(peer, expected, sessionFile).then(
				() => finish(undefined, { command: true, closed: true }),
				(error) =>
					finish(
						deliveryError(
							`Pi shut down, but its terminal could not be closed: ${error.message}`,
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

/** Closes an exited worker's terminal, refusing when another session holds it now. */
export async function closeExitedTerminal(peer, expected, sessionFile) {
	const current = await peer.terminal(expected.terminal_id);
	if (current.agent_session?.value && current.agent_session.value !== sessionFile)
		throw new Error("Target session changed; resolve it again");
	await peer.closeTerminal(expected.terminal_id);
}
