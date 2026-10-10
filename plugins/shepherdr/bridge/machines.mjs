// Remote machines: Herdr's SSH machine catalog, and running bridge operations
// on a machine over noninteractive SSH. The bridge's files are copied once per
// version to ~/.local/share/claude-shepherdr/bridge/<version>/ on the machine;
// OpenSSH owns authentication and nothing stays running between operations.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const LOCAL = "local";
const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function isLocal(machine) {
	return !machine || machine === LOCAL;
}

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
				/^[a-zA-Z0-9_.-]{1,64}$/.test(machine.session) &&
				typeof machine.enabled === "boolean",
		)
	)
		throw new Error("Herdr machine list returned an invalid catalog");
	return machines;
}

export async function machineFor(id) {
	const machine = (await catalog()).find((candidate) => candidate.id === id);
	if (!machine)
		throw new Error(
			`unknown machine ${id}; use the machine ID that list returns, not its label`,
		);
	if (!machine.enabled)
		throw new Error(`machine ${machine.label} is disabled in Herdr`);
	return machine;
}

/** The bridge's own files and a version derived from their content. */
async function bundle() {
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
}

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const remoteDir = (version) =>
	`"$HOME"/.local/share/claude-shepherdr/bridge/${version}`;

// Runs on the machine: writes the bundle into a fresh directory, then renames
// it into place, so a version directory is either complete or absent.
const INSTALL_SOURCE = String.raw`
const { mkdir, rename, rm, writeFile, stat } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => void (async () => {
  const { version, files } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!/^[a-f0-9]{16}$/.test(version)) throw new Error("invalid bridge version");
  const dir = join(homedir(), ".local", "share", "claude-shepherdr", "bridge", version);
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

function ssh(machine, command, input, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"ssh",
			["-T", "-o", "BatchMode=yes", "--", machine.target, command],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const timer =
			timeoutMs &&
			setTimeout(() => {
				child.kill();
				reject(new Error(`${machine.label} did not answer within ${timeoutMs} ms`));
			}, timeoutMs);
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

const exists = (path) => readFile(path).then(() => true, () => false);

/** Installs this bridge version on the machine unless a local marker says it is there. */
async function ensureInstalled(machine) {
	const { files, version } = await bundle();
	const marker = deployedMarker(machine, version);
	if (await exists(marker)) return { version, marker };
	const result = await ssh(
		machine,
		`node -e ${shellQuote(INSTALL_SOURCE)}`,
		JSON.stringify({ version, files }),
		60_000,
	);
	if (result.code !== 0)
		throw new Error(
			`could not install the Shepherdr bridge on ${machine.label}: ${result.stderr.trim() || `ssh exited ${result.code}`}`,
		);
	await mkdir(dirname(marker), { recursive: true });
	await writeFile(marker, "");
	return { version, marker };
}

/** Runs one bridge operation on the machine and resolves its result. */
export async function remoteCall(machineId, op, params, timeoutMs) {
	const machine = await machineFor(machineId);
	const { version, marker } = await ensureInstalled(machine);
	const command = `exec node ${remoteDir(version)}/cli.mjs --session ${shellQuote(machine.session)}`;
	const result = await ssh(
		machine,
		command,
		JSON.stringify({ op, ...params }),
		timeoutMs,
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

/** Starts a remote watcher; the caller reads its stdout lines. */
export async function spawnRemoteWatcher(machineId, targets) {
	const machine = await machineFor(machineId);
	const { version } = await ensureInstalled(machine);
	const child = spawn(
		"ssh",
		[
			"-T",
			"-o",
			"BatchMode=yes",
			"--",
			machine.target,
			`exec node ${remoteDir(version)}/watch.mjs --session ${shellQuote(machine.session)}`,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	// Kept open: the remote watcher exits when it closes with this connection.
	child.stdin.write(`${JSON.stringify({ targets })}\n`);
	return { child, label: machine.label };
}
