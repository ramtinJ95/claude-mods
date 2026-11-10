// Remote machines: Herdr Core's machine catalog, and running bridge scripts
// on a machine through Core (`hc exec --on`), which owns the connection and
// its authentication. The bridge's files are copied once per version to
// ~/.local/share/claude-shepherdr/bridge/<version>/ on the machine; nothing
// stays running between operations. Callers resolve a machine once and pass
// the catalog entry along.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hcBinary, request } from "./core.mjs";

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Where a machine keeps installed bridge versions, under its home directory. */
const REMOTE_BRIDGE = [".local", "share", "claude-shepherdr", "bridge"];
// Core ends an exec after ten minutes at most.
const LONGEST_EXEC_S = 600;

/** The machines added to this Core: `{ id, name, host, state, session }`. */
export async function catalog() {
	const machines = (await request("machine.list", {}, 15_000))?.machines;
	if (
		!Array.isArray(machines) ||
		!machines.every((machine) =>
			["id", "name", "host", "state"].every(
				(field) => typeof machine?.[field] === "string" && machine[field],
			),
		)
	)
		throw new Error("Core machine.list returned an invalid catalog");
	return machines.map(({ id, name, host, state, session }) => ({
		id,
		name,
		host,
		state,
		session: typeof session === "string" && session ? session : "default",
	}));
}

/** The connected catalog entry for a machine's stable ID or exact current name. */
export async function resolveMachine(selector) {
	const machines = await catalog();
	const byId = machines.find((machine) => machine.id === selector);
	const byName = machines.filter((machine) => machine.name === selector);
	if (!byId && byName.length > 1)
		throw new Error(`machine name ${selector} is ambiguous; use its ID from list`);
	const machine = byId ?? byName[0];
	if (!machine)
		throw new Error(
			`unknown machine ${selector}; use a machine name or ID that list returns`,
		);
	if (machine.state !== "connected")
		throw new Error(
			`machine ${machine.name} is ${machine.state}; reconnect it in Herdr (hc machine ls) and retry`,
		);
	return machine;
}

/** The bridge's own files and a version derived from their content, read once per process. */
let bundled;
function bundle() {
	bundled ??= (async () => {
		const files = {};
		const walk = async (directory) => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.name.endsWith(".mjs"))
					files[relative(BRIDGE_DIR, path)] = await readFile(path, "utf8");
			}
		};
		await walk(BRIDGE_DIR);
		const hash = createHash("sha256");
		for (const name of Object.keys(files).sort())
			hash.update(name).update("\0").update(files[name]).update("\0");
		return { files, version: hash.digest("hex").slice(0, 16) };
	})();
	return bundled;
}

// Runs on the machine: writes the bundle into a fresh directory, then renames
// it into place, so a version directory is either complete or absent.
const INSTALL_SOURCE = String.raw`
const { mkdir, rename, rm, writeFile, stat } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => void (async () => {
  const { root, version, files } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!/^[a-f0-9]{16}$/.test(version)) throw new Error("invalid bridge version");
  const dir = join(homedir(), ...root, version);
  if (await stat(dir).then(() => true, () => false)) return;
  const temporary = dir + "." + process.pid + ".tmp";
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(temporary, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(temporary, name), text, { mode: 0o600 });
  }
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await rename(temporary, dir).catch(async (error) => {
    await rm(temporary, { recursive: true, force: true });
    if (!(await stat(dir).then(() => true, () => false))) throw error;
  });
})().catch((error) => { process.stderr.write(error.message + "\n"); process.exit(1); }));
`;

/** Runs `argv` on the machine through Core; stdout and stdin stay the caller's. */
function execChild(machine, argv, timeoutS) {
	return spawn(
		hcBinary(),
		[
			"exec",
			"--on",
			machine.id,
			"--timeout",
			String(Math.min(LONGEST_EXEC_S, Math.max(1, Math.ceil(timeoutS)))),
			// The bridge there reaches this session's Core with `hc connect`.
			"--env",
			`HC_SESSION=${machine.session}`,
			"-i",
			"--",
			...argv,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
}

/** A bridge script of `version` on the machine; relative paths start at its home. */
const bridgeArgv = (version, script) => [
	"node",
	[...REMOTE_BRIDGE, version, script].join("/"),
];

/** Runs `argv` on the machine with `input`, collecting its output, until `deadline`. */
export function execOn(machine, argv, input, deadline) {
	return new Promise((resolve, reject) => {
		const child = execChild(machine, argv, (deadline - Date.now()) / 1000);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(
			() => {
				child.kill();
				reject(new Error(`${machine.name} did not answer in time`));
			},
			Math.max(1, deadline - Date.now() + 2_000),
		);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
		});
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-8192);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		// hc that exits before reading its input breaks the pipe; its exit code
		// and stderr, reported on close, say why.
		child.stdin.on("error", () => {});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

function deployedMarker(machine, version) {
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(data, "claude-shepherdr", "deployed", `${machine.id}-${version}`);
}

/** Installs this bridge version on the machine unless a local marker says it is there. */
async function ensureInstalled(machine, deadline) {
	const { files, version } = await bundle();
	const marker = deployedMarker(machine, version);
	if (await readFile(marker).then(() => true, () => false))
		return { version, marker };
	const result = await execOn(
		machine,
		["node", "-e", INSTALL_SOURCE],
		JSON.stringify({ root: REMOTE_BRIDGE, version, files }),
		deadline,
	);
	if (result.code !== 0)
		throw new Error(
			`could not install the Shepherdr bridge on ${machine.name}: ${result.stderr.trim() || `hc exec exited ${result.code}`} (the bridge needs Node.js on that machine's PATH)`,
		);
	await mkdir(dirname(marker), { recursive: true });
	await writeFile(marker, "");
	return { version, marker };
}

/**
 * Runs one bridge operation on the machine before `deadline` and resolves its
 * result. The machine gets the time left, not the deadline, since its clock
 * may differ; `marginMs` leaves room for the reply to travel back.
 */
export async function remoteCall(machine, op, params, deadline, marginMs) {
	const { version, marker } = await ensureInstalled(machine, deadline);
	const result = await execOn(
		machine,
		bridgeArgv(version, "cli.mjs"),
		JSON.stringify({ op, ...params, budgetMs: deadline - Date.now() - marginMs }),
		deadline,
	);
	const line = result.stdout.trim().split("\n").at(-1) ?? "";
	let reply;
	try {
		reply = JSON.parse(line);
	} catch {
		// A removed install fails before any operation ran; reinstall next time.
		if (/Cannot find module/.test(result.stderr))
			await rm(marker, { force: true });
		throw new Error(
			`${machine.name} bridge failed: ${result.stderr.trim() || `hc exec exited ${result.code}`}`,
		);
	}
	if (!reply.ok) throw new Error(reply.error.message);
	return reply.result;
}

/**
 * Runs the machine's transcript watcher once: it returns when a watched
 * transcript changes or its time runs out, with one JSON line per change.
 */
export async function watchOnce(machine, input, deadline) {
	const { version, marker } = await ensureInstalled(machine, deadline);
	const result = await execOn(
		machine,
		bridgeArgv(version, "watch.mjs"),
		JSON.stringify(input),
		deadline,
	);
	if (result.code !== 0) {
		if (/Cannot find module/.test(result.stderr)) await rm(marker, { force: true });
		throw new Error(
			`${machine.name} watcher failed: ${result.stderr.trim() || `hc exec exited ${result.code}`}`,
		);
	}
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
