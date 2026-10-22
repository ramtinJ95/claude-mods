// Remote machines: Herdr's SSH machine catalog, and running bridge scripts on
// a machine over noninteractive SSH. The bridge's files are copied once per
// version to ~/.local/share/claude-shepherdr/bridge/<version>/ on the machine;
// OpenSSH owns authentication and nothing stays running between operations.
// Callers resolve a machine once and pass the catalog entry along.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isSessionName } from "./herdr.mjs";

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Where a machine keeps installed bridge versions, under its home directory. */
const REMOTE_BRIDGE = [".local", "share", "claude-shepherdr", "bridge"];

/** Herdr's saved SSH machines by opaque profile ID, from the host running Claude Code. */
export async function catalog() {
	const binary = process.env.HERDR_BIN_PATH?.trim() || "herdr";
	const { stdout } = await promisify(execFile)(
		binary,
		["machine", "list", "--json"],
		{ timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
	);
	const machines = JSON.parse(stdout);
	if (
		!Array.isArray(machines) ||
		!machines.every(
			(machine) =>
				/^[a-f0-9]{32}$/.test(machine?.id) &&
				typeof machine.label === "string" &&
				typeof machine.target === "string" &&
				!machine.target.startsWith("-") &&
				isSessionName(machine.session) &&
				typeof machine.enabled === "boolean",
		)
	)
		throw new Error("Herdr machine list returned an invalid catalog");
	return machines;
}

/** The enabled catalog entry for a machine ID. */
export async function resolveMachine(id) {
	const machine = (await catalog()).find((candidate) => candidate.id === id);
	if (!machine)
		throw new Error(
			`unknown machine ${id}; use the machine ID that list returns, not its label`,
		);
	if (!machine.enabled)
		throw new Error(`machine ${machine.label} is disabled in Herdr`);
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

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

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

/** Spawns `command` on the machine; stdout and stdin stay the caller's. */
function sshChild(machine, command) {
	return spawn(
		"ssh",
		["-T", "-o", "BatchMode=yes", "--", machine.target, command],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
}

/** A bridge script of `version` on the machine, run against its Herdr session. */
function bridgeCommand(machine, version, script) {
	const path = [...REMOTE_BRIDGE, version, script].join("/");
	return `exec node "$HOME"/${path} --session ${shellQuote(machine.session)}`;
}

/** Runs `command` with `input`, collecting its output, until `deadline`. */
function ssh(machine, command, input, deadline) {
	return new Promise((resolve, reject) => {
		const child = sshChild(machine, command);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(
			() => {
				child.kill();
				reject(new Error(`${machine.label} did not answer in time`));
			},
			Math.max(1, deadline - Date.now()),
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
		// ssh that exits before reading its input (host down, key refused)
		// breaks the pipe; its exit code and stderr, reported on close, say why.
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
	const result = await ssh(
		machine,
		`node -e ${shellQuote(INSTALL_SOURCE)}`,
		JSON.stringify({ root: REMOTE_BRIDGE, version, files }),
		deadline,
	);
	if (result.code !== 0)
		throw new Error(
			`could not install the Shepherdr bridge on ${machine.label}: ${result.stderr.trim() || `ssh exited ${result.code}`}`,
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
	const result = await ssh(
		machine,
		bridgeCommand(machine, version, "cli.mjs"),
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
			`${machine.label} bridge failed: ${result.stderr.trim() || `ssh exited ${result.code}`}`,
		);
	}
	if (!reply.ok) throw new Error(reply.error.message);
	return reply.result;
}

/** Starts the machine's watcher; the caller reads its stdout lines. */
export async function spawnRemoteWatcher(machine, targets) {
	const { version } = await ensureInstalled(machine, Date.now() + 60_000);
	const child = sshChild(machine, bridgeCommand(machine, version, "watch.mjs"));
	// A connection that closes early breaks this pipe; the caller's close
	// handler reports why, from ssh's exit code and stderr.
	child.stdin.on("error", () => {});
	// Kept open: the remote watcher exits when it closes with this connection.
	child.stdin.write(`${JSON.stringify({ targets })}\n`);
	return child;
}
