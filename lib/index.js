/**
 * dsh-ollama-vision-bridge — runtime companion row.
 *
 * The functional part of this plugin is the install-time patcher
 * (patch/apply.mjs): it patches the chat prompt admission in
 * @deepseek-ai/dsh-api-session-controller (DSH >= 0.2.0-rc.1) so a text-only
 * chat model receives a VL description of attached images. On DSH >= 0.2.0
 * the bridge config comes from the `vision-bridge` profile entry
 * (cordis.patch.yml) and this row publishes it to
 * `globalThis.__DSH_OLLAMA_VISION_BRIDGE__` for the injected helpers; legacy
 * hosts fall back to the settings.yaml / vision-bridge.yaml files.
 *
 * This module also registers a `/vision-bridge` chat command (status / model /
 * base-url / keep-alive / reset) that edits the live profile configuration
 * through `ctx.configEditor` and republishes the in-memory bridge config, so
 * the model can be switched from the chat box without touching YAML.
 *
 * It is deliberately defensive: it never throws, so mounting or removing it
 * can never break a profile boot.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "vision-bridge";
const GLOBAL_KEY = "__DSH_OLLAMA_VISION_BRIDGE__";
const MARKER = "DSH OLLAMA VISION BRIDGE PATCH v4";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_KEEP_ALIVE = "60s";
const USAGE = "status | model <name> | base-url <url> | keep-alive <value> | reset";

/** Files the install-time patcher touches, relative to the controller package lib/. */
const TARGETS = ["index.js", "types/commands.js"];

/**
 * Plugin settings: the vision-bridge fallback used for text-only chat models.
 *
 * The schema is built with @deepseek-ai/schemastery when the host can resolve
 * it (npm/pnpm peer layout). A bare `file:`/workspace mount may not resolve
 * peer packages, so the import is tolerant: without the schema the loader
 * passes the raw profile entry config and `resolved()` below still works.
 */
let schema;
try {
	const { default: z } = await import("@deepseek-ai/schemastery");
	schema = z.object({
		/** Master switch; false restores the native DSH image rejection. */
		enabled: z.boolean().default(true).volatile(),
		/** Ollama endpoint (OpenAI-compatible base, e.g. http://127.0.0.1:11434). */
		baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
		/** VL model asked to describe attached images. */
		model: z.string().default("qwen3-vl:8b").volatile(),
		/** Ollama keep_alive for the VL request; the model unloads after this idle window. */
		keepAlive: z.string().default(DEFAULT_KEEP_ALIVE).volatile(),
		/** Optional per-chat-model mapping: { "<text model>": "<vl model>" }. */
		models: z.dict(z.string()).default({}).volatile(),
		/** Optional custom description prompt (Chinese by default). */
		prompt: z.string().default("").volatile(),
		/** Per-description timeout in milliseconds. */
		timeoutMs: z.number().default(300000).volatile()
	});
} catch {
	schema = void 0;
}
export const Config = schema;

/** Read a volatile settings accessor or a plain value. */
function read(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}

/** Resolve the row config into the plain object the injected helpers consume. */
function resolved(config) {
	return {
		enabled: read(config.enabled) !== false,
		baseURL: String(read(config.baseURL) ?? DEFAULT_BASE_URL),
		model: String(read(config.model) ?? ""),
		keepAlive: String(read(config.keepAlive) ?? DEFAULT_KEEP_ALIVE),
		models: read(config.models) ?? {},
		prompt: String(read(config.prompt) ?? ""),
		timeoutMs: Number(read(config.timeoutMs)) || 300000
	};
}

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function controllerLib() {
	return join(dshHome(), "profiles", "node_modules", "@deepseek-ai", "dsh-api-session-controller", "lib");
}

function targetFiles() {
	const lib = controllerLib();
	return TARGETS.map((rel) => ({ file: join(lib, rel), patched: false }));
}

function status() {
	const targets = targetFiles();
	for (const t of targets) {
		try {
			const text = readFileSync(t.file, "utf8");
			// The v2+ patch keeps the refusal as a conditional throw inside the
			// bridge branch, so presence of the versioned marker is the signal.
			t.patched = text.includes(MARKER);
		} catch {
			t.patched = false;
		}
	}
	const legacyCfg = join(dshHome(), "vision-bridge.yaml");
	let settingsSection = false;
	try {
		settingsSection = /^vision-bridge:/m.test(readFileSync(join(dshHome(), "settings.yaml"), "utf8"));
	} catch {
		settingsSection = false;
	}
	return {
		targets,
		patched: targets.every((t) => t.patched),
		anyPatched: targets.some((t) => t.patched),
		configured: existsSync(legacyCfg) || settingsSection,
		legacyCfg,
		settingsSection
	};
}

/** Read one loader entry's plain config object. */
function entryConfig(entry) {
	const value = entry?.options?.config;
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Re-find a profile entry after a config edit (reconciliation can replace it). */
function findEntry(ctx, id) {
	const entries = typeof ctx.configEditor?.entries === "function" ? ctx.configEditor.entries() : [];
	return entries.find((entry) => entry?.options?.id === id);
}

/** Publish the entry config into the process-global object the helpers read. */
function publish(ctx) {
	const stored = entryConfig(findEntry(ctx, "vision-bridge"));
	const live = globalThis[GLOBAL_KEY] ?? {};
	const next = {
		enabled: typeof stored.enabled === "boolean" ? stored.enabled : live.enabled !== false,
		baseURL: typeof stored.baseURL === "string" && stored.baseURL !== "" ? stored.baseURL : live.baseURL ?? DEFAULT_BASE_URL,
		model: typeof stored.model === "string" ? stored.model : live.model ?? "",
		keepAlive: typeof stored.keepAlive === "string" || typeof stored.keepAlive === "number" ? stored.keepAlive : live.keepAlive ?? DEFAULT_KEEP_ALIVE,
		models: stored.models !== null && typeof stored.models === "object" ? stored.models : live.models ?? {},
		prompt: typeof stored.prompt === "string" ? stored.prompt : live.prompt ?? "",
		timeoutMs: Number(stored.timeoutMs ?? live.timeoutMs) || 300000
	};
	globalThis[GLOBAL_KEY] = next;
	return next;
}

/** Render the current bridge configuration and patch state. */
function statusText() {
	const cfg = globalThis[GLOBAL_KEY] ?? {};
	const st = status();
	const lines = [
		"Ollama vision bridge",
		`Model: ${typeof cfg.model === "string" && cfg.model !== "" ? cfg.model : "(unset)"}`,
		`Base URL: ${typeof cfg.baseURL === "string" && cfg.baseURL !== "" ? cfg.baseURL : DEFAULT_BASE_URL}`,
		`keep_alive: ${typeof cfg.keepAlive === "string" || typeof cfg.keepAlive === "number" ? cfg.keepAlive : DEFAULT_KEEP_ALIVE}`,
		`Host patch: ${st.patched ? "OK" : "MISSING — run patch/apply.mjs and restart dsh"}`,
		`Usage: /vision-bridge ${USAGE}`
	];
	return lines.join("\n");
}

/** Quick check whether a model is present in the local Ollama instance. */
async function probeModel(baseURL, model) {
	try {
		const response = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) return { state: "unknown", detail: `Ollama returned HTTP ${response.status}` };
		const payload = await response.json();
		const names = Array.isArray(payload.models) ? payload.models.map((entry) => String(entry.name ?? "")) : [];
		const found = names.includes(model) || names.some((name) => name === `${model}:latest` || name.startsWith(`${model}:`));
		return found ? { state: "found" } : { state: "missing", detail: names.join(", ") || "(none)" };
	} catch {
		return { state: "unknown", detail: "Ollama unreachable" };
	}
}

async function editEntry(ctx, field, value) {
	const entry = findEntry(ctx, "vision-bridge");
	if (entry === undefined) {
		return { kind: "error", text: "The vision-bridge entry is not mounted in this profile; install the plugin and restart DSH." };
	}
	try {
		await ctx.configEditor.edit(entry, (current) => {
			const next = { ...current };
			if (value === void 0) delete next[field];
			else next[field] = value;
			return next;
		});
		const cfg = publish(ctx);
		const shown = value === void 0 ? "(default)" : String(value);
		return { kind: "success", text: `vision-bridge ${field} set to ${shown}\nModel: ${cfg.model || "(unset)"} · Base URL: ${cfg.baseURL} · keep_alive: ${cfg.keepAlive}` };
	} catch (error) {
		return { kind: "error", text: `Could not save ${field}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function setModel(ctx, name) {
	if (name === "") return { kind: "error", text: `Missing model name. Usage: /vision-bridge model <name>` };
	const cfg = globalThis[GLOBAL_KEY] ?? {};
	const baseURL = typeof cfg.baseURL === "string" && cfg.baseURL !== "" ? cfg.baseURL : DEFAULT_BASE_URL;
	const probe = await probeModel(baseURL, name);
	if (probe.state === "missing") {
		return { kind: "error", text: `Model "${name}" is not present in Ollama at ${baseURL}.\nAvailable: ${probe.detail}\nPull it first (ollama pull ${name}) or pick an installed VL model.` };
	}
	const result = await editEntry(ctx, "model", name);
	if (result.kind === "success" && probe.state === "unknown") {
		return { ...result, text: `${result.text}\n(warning: could not verify the model — ${probe.detail})` };
	}
	return result;
}

function normalizeBaseURL(raw) {
	const withScheme = /^https?:\/\//iu.test(raw) ? raw : `http://${raw}`;
	let url;
	try {
		url = new URL(withScheme);
	} catch {
		return void 0;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
	if (url.username !== "" || url.password !== "") return void 0;
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	url.search = "";
	url.hash = "";
	return url.href.replace(/\/+$/u, "");
}

async function setBaseURL(ctx, raw) {
	const parsed = normalizeBaseURL(raw);
	if (parsed === void 0) return { kind: "error", text: "Invalid URL. Use an absolute http(s) URL without credentials, e.g. http://127.0.0.1:11434" };
	return editEntry(ctx, "baseURL", parsed);
}

async function setKeepAlive(ctx, raw) {
	if (!/^(\d+(s|m|h)?|0)$/iu.test(raw)) return { kind: "error", text: "Invalid keep_alive. Use e.g. 60s, 10m, or 0 (unload immediately)." };
	return editEntry(ctx, "keepAlive", raw);
}

async function resetConfig(ctx) {
	const entry = findEntry(ctx, "vision-bridge");
	if (entry === undefined) return { kind: "error", text: "The vision-bridge entry is not mounted in this profile." };
	try {
		await ctx.configEditor.edit(entry, (current) => {
			const next = { ...current };
			delete next.model;
			delete next.baseURL;
			delete next.keepAlive;
			return next;
		});
		const cfg = publish(ctx);
		return { kind: "success", text: `vision-bridge configuration reset to defaults.\nModel: ${cfg.model || "(unset)"} · Base URL: ${cfg.baseURL} · keep_alive: ${cfg.keepAlive}` };
	} catch (error) {
		return { kind: "error", text: `Could not reset the vision-bridge configuration: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Register `/vision-bridge` when the interactive services exist. */
function applyCommand(ctx) {
	ctx.effect(
		() =>
			ctx.commands.register({
				name: "vision-bridge",
				description: "Show or change the local Ollama VL model used by the vision bridge",
				input: { hint: USAGE },
				handler: async (invocation) => {
					const raw = String(invocation?.rawInput ?? "").trim();
					const [verb, ...rest] = raw.split(/\s+/u);
					const arg = rest.join(" ").trim();
					const command = (verb ?? "").toLowerCase();
					if (command === "" || command === "status") return { kind: "success", text: statusText() };
					if (command === "model" || command === "set-model") return setModel(ctx, arg);
					if (command === "base-url" || command === "baseurl") return setBaseURL(ctx, arg);
					if (command === "keep-alive" || command === "keepalive") return setKeepAlive(ctx, arg);
					if (command === "reset") return resetConfig(ctx);
					return { kind: "error", text: `Unknown subcommand "${verb}". Usage: /vision-bridge ${USAGE}` };
				}
			}),
		"dsh-ollama-vision-bridge /vision-bridge command"
	);
}

function apply(ctx, config) {
	try {
		const cfg = resolved(config ?? {});
		globalThis[GLOBAL_KEY] = cfg;
		const s = status();
		ctx.logger.info(
			`vision-bridge: model ${cfg.model} @ ${cfg.baseURL} (keepAlive ${cfg.keepAlive}); host patch ${s.patched ? "OK" : "MISSING — run patch/apply.mjs, then restart dsh"}`
		);
		if (typeof ctx.inject === "function") {
			ctx.inject(["commands", "configEditor"], (child) => {
				applyCommand(child);
			});
		}
	} catch (error) {
		try {
			ctx.logger.warn(`vision-bridge: status check failed: ${String(error)}`);
		} catch {
			// never propagate
		}
	}
}

export { apply };
