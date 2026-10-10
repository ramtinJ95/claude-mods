// Agent profiles. Pi Shepherdr's installed profiles are authoritative when
// present so both controllers launch the same agent types; otherwise this
// mod's bundled copies are used read-only.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELDS = new Set([
	"accepts",
	"blocking",
	"description",
	"model",
	"pi_args",
	"prepare",
	"prompt",
	"share_context",
	"thinking",
]);

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

async function profilesSource() {
	const shared = join(piAgentDir(), "shepherdr", "profiles");
	if (await isDirectory(shared))
		return { directory: shared, source: "pi-shepherdr" };
	return {
		directory: fileURLToPath(new URL("../profiles", import.meta.url)),
		source: "bundled",
	};
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

async function readProfile(name, directory) {
	const parsed = JSON.parse(
		await readFile(join(directory, "profile.json"), "utf8"),
	);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${name} profile must be an object`);
	const unknown = Object.keys(parsed).filter((key) => !FIELDS.has(key));
	if (unknown.length)
		throw new Error(`unknown ${name} profile field(s): ${unknown.join(", ")}`);
	if (parsed.blocking !== undefined && typeof parsed.blocking !== "boolean")
		throw new Error(`${name}.blocking must be a boolean`);
	const prompt = text(parsed.prompt, `${name}.prompt`);
	const prepare = text(parsed.prepare, `${name}.prepare`);
	return {
		name,
		description: text(parsed.description, `${name}.description`, true),
		model: text(parsed.model, `${name}.model`, true),
		thinking: text(parsed.thinking, `${name}.thinking`, true),
		accepts: strings(parsed.accepts, `${name}.accepts`),
		piArgs: strings(parsed.pi_args, `${name}.pi_args`),
		...(parsed.blocking === undefined ? {} : { blocking: parsed.blocking }),
		...(prompt ? { promptPath: resolve(directory, prompt) } : {}),
		...(prepare ? { prepare: resolve(directory, prepare) } : {}),
	};
}

export async function loadProfile(name) {
	if (!PROFILE_NAME.test(name)) throw new Error(`invalid agent_type: ${name}`);
	const { directory } = await profilesSource();
	try {
		return await readProfile(name, join(directory, name));
	} catch (error) {
		if (error.code === "ENOENT")
			throw new Error(
				`unknown agent_type ${name}; call help for available profiles`,
			);
		throw error;
	}
}

export async function listProfiles() {
	const { directory, source } = await profilesSource();
	const entries = await readdir(directory, { withFileTypes: true });
	const profiles = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !PROFILE_NAME.test(entry.name)) continue;
		const profile = await readProfile(entry.name, join(directory, entry.name));
		profiles.push({
			name: profile.name,
			description: profile.description,
			model: profile.model,
			thinking: profile.thinking,
			...(profile.accepts.length ? { accepts: profile.accepts } : {}),
			...(profile.blocking === undefined ? {} : { blocking: profile.blocking }),
		});
	}
	return { source, profiles };
}

export function profileArgs(profile) {
	return [
		"--model",
		profile.model,
		"--thinking",
		profile.thinking,
		...(profile.promptPath
			? ["--append-system-prompt", profile.promptPath]
			: []),
		...profile.piArgs,
	];
}

export async function prepareMessage(profile, { cwd, message, base }) {
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
	const prepared = await module.prepare({ cwd, message, base, local: true });
	if (typeof prepared !== "string" || !prepared.trim())
		throw new Error(`${profile.name}.prepare must return a non-empty string`);
	return prepared;
}
