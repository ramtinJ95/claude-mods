// Agent profiles. Pi profiles: Pi Shepherdr's installed ones are authoritative
// when present so both controllers launch the same agent types; otherwise this
// mod's bundled copies are used read-only. Claude Code profiles live apart, so
// Pi Shepherdr never reads their fields: the user's directory when present,
// otherwise the bundled ones.
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SHARED_FIELDS = ["accepts", "blocking", "description", "model", "prepare", "prompt"];
const FIELDS = {
	pi: new Set([...SHARED_FIELDS, "pi_args", "share_context", "thinking"]),
	claude: new Set([...SHARED_FIELDS, "claude_args", "effort", "permission_mode"]),
};

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/** Pi's agent directory, where pi-shepherdr profiles and Pi keybindings live. */
export function piAgentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

const bundled = (directory) => fileURLToPath(new URL(`../${directory}`, import.meta.url));

/** Each agent kind's profile directory and where it came from. */
async function profilesSources() {
	const pi = join(piAgentDir(), "shepherdr", "profiles");
	const claude = join(
		process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
		"claude-shepherdr",
		"profiles",
	);
	return [
		(await isDirectory(pi))
			? { agent: "pi", directory: pi, source: "pi-shepherdr" }
			: { agent: "pi", directory: bundled("profiles"), source: "bundled" },
		(await isDirectory(claude))
			? { agent: "claude", directory: claude, source: claude }
			: { agent: "claude", directory: bundled("claude-profiles"), source: "bundled" },
	];
}

function text(value, field, required) {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function strings(value, field) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error(`${field} must be an array of strings`);
	return value;
}

async function readProfile(name, directory, agent) {
	const parsed = JSON.parse(
		await readFile(join(directory, "profile.json"), "utf8"),
	);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${name} profile must be an object`);
	const unknown = Object.keys(parsed).filter((key) => !FIELDS[agent].has(key));
	if (unknown.length)
		throw new Error(`unknown ${name} profile field(s): ${unknown.join(", ")}`);
	if (parsed.blocking !== undefined && typeof parsed.blocking !== "boolean")
		throw new Error(`${name}.blocking must be a boolean`);
	const prompt = text(parsed.prompt, `${name}.prompt`);
	const prepare = text(parsed.prepare, `${name}.prepare`);
	const common = {
		name,
		agent,
		description: text(parsed.description, `${name}.description`, true),
		model: text(parsed.model, `${name}.model`, true),
		accepts: strings(parsed.accepts, `${name}.accepts`),
		...(parsed.blocking === undefined ? {} : { blocking: parsed.blocking }),
		...(prompt ? { promptPath: resolve(directory, prompt) } : {}),
		...(prepare ? { prepare: resolve(directory, prepare) } : {}),
	};
	if (agent === "pi")
		return {
			...common,
			thinking: text(parsed.thinking, `${name}.thinking`, true),
			piArgs: strings(parsed.pi_args, `${name}.pi_args`),
		};
	return {
		...common,
		effort: text(parsed.effort, `${name}.effort`, true),
		permissionMode: text(parsed.permission_mode, `${name}.permission_mode`, true),
		claudeArgs: strings(parsed.claude_args, `${name}.claude_args`),
	};
}

async function profileEntries({ directory }) {
	return (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name))
		.map((entry) => entry.name);
}

export async function loadProfile(name) {
	if (!PROFILE_NAME.test(name)) throw new Error(`invalid agent_type: ${name}`);
	const sources = await profilesSources();
	const found = await Promise.all(
		sources.map(({ directory }) => isDirectory(join(directory, name))),
	);
	const matches = sources.filter((_, index) => found[index]);
	if (matches.length === 0)
		throw new Error(`unknown agent_type ${name}; call help for available profiles`);
	if (matches.length > 1)
		throw new Error(
			`agent_type ${name} is both a Pi and a Claude Code profile; rename one`,
		);
	const [{ directory, agent }] = matches;
	return readProfile(name, join(directory, name), agent);
}

export async function listProfiles() {
	const profiles = [];
	const sources = {};
	for (const source of await profilesSources()) {
		sources[source.agent] = source.source;
		for (const name of await profileEntries(source)) {
			const profile = await readProfile(name, join(source.directory, name), source.agent);
			profiles.push({
				name: profile.name,
				...(profile.agent === "claude" ? { agent: "claude" } : {}),
				description: profile.description,
				model: profile.model,
				...(profile.agent === "pi"
					? { thinking: profile.thinking }
					: { effort: profile.effort }),
				...(profile.accepts.length ? { accepts: profile.accepts } : {}),
				...(profile.blocking === undefined ? {} : { blocking: profile.blocking }),
			});
		}
	}
	return { sources, profiles };
}

/**
 * Claude Code holds a peer message for its person when exactly one of sender
 * and worker bypasses permissions; a worker accepts its controller's tasks
 * whatever their modes. Only the last `--settings` applies, so the profile's
 * own (inline JSON or an absolute file) is merged in, and its explicit
 * `crossSessionInbound` wins.
 */
async function workerSettings(name, claudeArgs) {
	const args = [];
	// Claude Code reads only the last flag; earlier ones do not apply.
	let last;
	for (let index = 0; index < claudeArgs.length; index += 1) {
		const arg = claudeArgs[index];
		const inline = arg.startsWith("--settings=");
		if (arg !== "--settings" && !inline) {
			args.push(arg);
			continue;
		}
		last = inline ? arg.slice("--settings=".length) : claudeArgs[++index];
		if (last === undefined) throw new Error(`${name}.claude_args --settings needs a value`);
	}
	let settings = {};
	if (last !== undefined) {
		let text = last.trim();
		if (!text.startsWith("{")) {
			const path = text.startsWith("~/") ? join(homedir(), text.slice(2)) : text;
			if (!path.startsWith("/"))
				throw new Error(`${name}.claude_args --settings needs inline JSON or an absolute path`);
			text = await readFile(path, "utf8");
		}
		try {
			settings = JSON.parse(text);
		} catch (error) {
			throw new Error(`${name}.claude_args --settings is not valid JSON: ${error.message}`);
		}
	}
	return [...args, "--settings", JSON.stringify({ crossSessionInbound: "accept", ...settings })];
}

/**
 * The worker's launch arguments. A remote worker cannot read this machine's
 * prompt file, so a Pi worker there gets the prompt as one line of text.
 */
export async function profileArgs(profile, local) {
	if (profile.agent === "claude")
		return [
			"--session-id",
			randomUUID(),
			"--model",
			profile.model,
			"--effort",
			profile.effort,
			"--permission-mode",
			profile.permissionMode,
			...(profile.promptPath
				? ["--append-system-prompt-file", profile.promptPath]
				: []),
			...(await workerSettings(profile.name, profile.claudeArgs)),
		];
	const prompt = !profile.promptPath
		? undefined
		: local
			? profile.promptPath
			: (await readFile(profile.promptPath, "utf8"))
					.replace(/\p{Cc}+/gu, " ")
					.replace(/\s+/gu, " ")
					.trim();
	return [
		"--model",
		profile.model,
		"--thinking",
		profile.thinking,
		...(prompt ? ["--append-system-prompt", prompt] : []),
		...profile.piArgs,
	];
}

/** The worker's task; `local` tells the profile's preparation whether it runs on the worker's machine. */
export async function prepareMessage(profile, { cwd, message, base, local }) {
	if (base && !profile.accepts.includes("base"))
		throw new Error(`base is not supported by ${profile.name}`);
	if (!profile.prepare)
		return base ? `Review base: ${base}\n\n${message}` : message;
	const { mtimeMs } = await stat(profile.prepare);
	const module = await import(
		`${pathToFileURL(profile.prepare).href}?mtime=${mtimeMs}`
	);
	if (typeof module.prepare !== "function")
		throw new Error(`${profile.name}.prepare must export prepare()`);
	const prepared = await module.prepare({ cwd, message, base, local });
	if (typeof prepared !== "string" || !prepared.trim())
		throw new Error(`${profile.name}.prepare must return a non-empty string`);
	return prepared;
}
