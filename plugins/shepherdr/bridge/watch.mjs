// One machine's watcher for a session's lifetime: streams one JSON line per
// worker change so the mod can reconcile it with `cli.mjs check`. The first
// stdin line is { machine?, targets: [{ terminalId, sessionPath? }] }.
//
// It runs beside Claude Code for every machine: this Core's event stream
// covers its connected machines' terminals too. Transcripts of a remote
// machine's workers are watched there, by this same file in `once` mode run
// through `hc exec`: it returns at the first write or when its time runs out,
// and the relay runs it again. Exits nonzero when monitoring breaks.
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { getAgent, isCoreError, subscribe, terminalAgent } from "./core.mjs";
import { catalog, resolveMachine, watchOnce } from "./machines.mjs";
import {
	ASK_ENTRY_MARKERS,
	readSessionView,
} from "./vendor/shepherdr-session.mjs";
import { watchSessions } from "./vendor/shepherdr-session-watch.mjs";

// One remote run stays under Core's ten-minute exec limit.
const REMOTE_WAIT_MS = 540_000;
// Writes that land together are reported together.
const COALESCE_MS = 200;

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const shutdown = (code) => {
	process.exitCode = code;
	process.stdout.end(() => process.exit());
};
const fail = (message) => {
	emit({ type: "error", message });
	shutdown(1);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

/** The worker's open background question, if its transcript holds one. */
async function steerAsk(path) {
	const { ask } = await readSessionView(path);
	return ask?.delivery === "steer" ? ask : undefined;
}

const sizeOf = (path) => stat(path).then(({ size }) => size, () => 0);

/**
 * Only Pi Ask's own entries can open a background question, so a write that
 * appends none is reported without reparsing the whole transcript.
 */
async function appendedAsk(path, sizes) {
	const size = await sizeOf(path);
	const from = sizes[path] ?? 0;
	sizes[path] = size;
	if (size <= from) return size < from ? steerAsk(path) : undefined;
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(size - from);
		await file.read(buffer, 0, buffer.length, from);
		return ASK_ENTRY_MARKERS.some((marker) => buffer.includes(marker))
			? steerAsk(path)
			: undefined;
	} finally {
		await file.close();
	}
}

async function sessionLine(path, sizes) {
	const ask = await appendedAsk(path, sizes).catch(() => undefined);
	return { type: "session", path, ...(ask ? { ask } : {}) };
}

/** Sizes now, and lines for background questions asked before watching began. */
async function baseline(paths) {
	const sizes = {};
	const lines = [];
	for (const path of paths) {
		sizes[path] = await sizeOf(path);
		const ask = await steerAsk(path).catch(() => undefined);
		if (ask) lines.push({ type: "session", path, ask });
	}
	return { sizes, lines };
}

/**
 * `once` mode, on the workers' machine: the first run takes a baseline and
 * reports earlier background questions; later runs wait for a write after
 * `sizes`. Ends with a `sizes` line for the next run.
 */
async function watchFilesOnce({ paths, sizes: since, budgetMs }) {
	const finish = (sizes, lines) => {
		for (const line of lines) emit(line);
		emit({ type: "sizes", sizes });
		shutdown(0);
	};
	if (!since) {
		const { sizes, lines } = await baseline(paths);
		return finish(sizes, lines);
	}
	const sizes = { ...since };
	const changed = new Set();
	let timer;
	let flushed = false;
	const flush = async () => {
		if (flushed) return;
		flushed = true;
		unwatch();
		clearTimeout(timer);
		const lines = [];
		for (const path of changed) lines.push(await sessionLine(path, sizes));
		finish(sizes, lines);
	};
	const unwatch = watchSessions(
		paths,
		(path) => {
			changed.add(path);
			clearTimeout(timer);
			timer = setTimeout(() => void flush(), COALESCE_MS);
		},
		(error) => fail(error.message),
	);
	// Writes made between runs, or before the watch began, are reported at once.
	for (const path of paths) if ((await sizeOf(path)) !== (sizes[path] ?? 0)) changed.add(path);
	if (changed.size) return flush();
	timer = setTimeout(() => void flush(), Math.max(0, budgetMs));
}

/** What the fleet acts on: the status, and the session a new label names. */
const stateOf = (agent) =>
	agent.live ? { status: agent.agent_status, session: agent.agent_session?.value ?? null } : { status: "closed" };

/**
 * Follows Core's events for the watched terminals, reporting each change of
 * status or session once, and `closed` when a terminal finished or was
 * removed. A remote machine's terminal is `<machine>/<address>` here, by its
 * ID or its name; a rename changes the name in later events.
 */
async function watchTerminals(targets, machine) {
	let machineName = machine?.name;
	const own = (address) => {
		if (!machine) return address;
		const [prefix, local] = address.split("/");
		return local && (prefix === machine.id || prefix === machineName)
			? `${machine.id}/${local}`
			: address;
	};
	const byAddress = new Map(
		targets.map(({ terminalId }) => [machine ? `${machine.id}/${terminalId}` : terminalId, terminalId]),
	);
	/**
	 * The watched address an event names, if any: the stream carries every
	 * terminal of this Core and its machines. Rereads the machine's name when it
	 * may have changed.
	 */
	const watchedAddress = async (terminal) => {
		if (byAddress.has(own(terminal))) return own(terminal);
		const local = machine && terminal.split("/")[1];
		if (!local || !byAddress.has(`${machine.id}/${local}`)) return undefined;
		const current = (await catalog()).find(({ id }) => id === machine.id);
		if (current) machineName = current.name;
		return byAddress.has(own(terminal)) ? own(terminal) : undefined;
	};
	const states = new Map();
	const report = async (address) => {
		let state;
		try {
			state = stateOf(await getAgent(address));
		} catch (error) {
			if (!isCoreError(error, "not_found")) throw error;
			state = { status: "closed" };
		}
		const key = JSON.stringify(state);
		if (states.get(address) === key) return;
		states.set(address, key);
		emit({ type: "event", pane: byAddress.get(address), status: state.status });
	};
	let chain = Promise.resolve();
	const queue = (terminal) => {
		chain = chain
			.then(async () => {
				// A `missed` snapshot names no terminal: any may have changed.
				const addresses =
					terminal === undefined ? [...byAddress.keys()] : [await watchedAddress(terminal)];
				for (const address of addresses) if (address) await report(address);
			})
			.catch((error) => fail(error.message));
	};
	const { terminals } = await subscribe({}, queue, (error) => fail(error.message));
	for (const record of terminals) {
		const address = own(record.address);
		if (byAddress.has(address)) states.set(address, JSON.stringify(stateOf(terminalAgent(record))));
	}
}

/** Watches before taking the baseline, so a write during it is reported after it. */
async function watchLocalFiles(paths) {
	let sizes;
	const early = new Set();
	watchSessions(
		paths,
		(path) => (sizes ? void sessionLine(path, sizes).then(emit) : early.add(path)),
		(error) => fail(error.message),
	);
	const base = await baseline(paths);
	sizes = base.sizes;
	for (const path of early) base.lines.push(await sessionLine(path, sizes));
	return base.lines;
}

/** Runs the machine's transcript watcher again and again, relaying what each run reports. */
async function relayRemoteFiles(machine, paths) {
	let sizes;
	for (;;) {
		const lines = await watchOnce(
			machine,
			{ once: true, paths, ...(sizes ? { sizes } : {}), budgetMs: REMOTE_WAIT_MS },
			Date.now() + REMOTE_WAIT_MS + 30_000,
		);
		for (const line of lines) {
			if (line.type === "sizes") sizes = line.sizes;
			else emit(line);
		}
		if (!sizes) throw new Error(`${machine.name} watcher returned no transcript sizes`);
	}
}

const lines = createInterface({ input: process.stdin });
const input = JSON.parse(
	await new Promise((resolve, reject) => {
		lines.once("line", resolve);
		lines.once("close", () => reject(new Error("watcher received no targets")));
	}),
);
try {
	if (input.once) await watchFilesOnce(input);
	else {
		const machine = input.machine ? await resolveMachine(input.machine) : undefined;
		const targets = input.targets;
		await watchTerminals(targets, machine);
		const paths = targets.map(({ sessionPath }) => sessionPath).filter(Boolean);
		const earlier = machine || !paths.length ? [] : await watchLocalFiles(paths);
		emit({ type: "ready" });
		for (const line of earlier) emit(line);
		if (machine && paths.length) await relayRemoteFiles(machine, paths);
	}
} catch (error) {
	fail(error.message);
}
