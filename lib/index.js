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
 * This module is a minimal Cordis row that reports patch/config status at
 * boot and offers a `vision-bridge` status command when the commands service
 * is available. It is deliberately defensive: it never throws, so mounting or
 * removing it can never break a profile boot.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "vision-bridge";
const GLOBAL_KEY = "__DSH_OLLAMA_VISION_BRIDGE__";
const MARKER = "DSH OLLAMA VISION BRIDGE PATCH v3";

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
		baseURL: z.string().default("http://127.0.0.1:11434").volatile(),
		/** VL model asked to describe attached images. */
		model: z.string().default("qwen3-vl:8b").volatile(),
		/** Ollama keep_alive for the VL request; the model unloads after this idle window. */
		keepAlive: z.string().default("60s").volatile(),
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
		baseURL: String(read(config.baseURL) ?? "http://127.0.0.1:11434"),
		model: String(read(config.model) ?? ""),
		keepAlive: String(read(config.keepAlive) ?? "60s"),
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
			t.patched = text.includes(MARKER) && !text.includes('throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`');
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

function apply(ctx, config) {
	try {
		const cfg = resolved(config ?? {});
		globalThis[GLOBAL_KEY] = cfg;
		const s = status();
		ctx.logger.info(
			`vision-bridge: model ${cfg.model} @ ${cfg.baseURL} (keepAlive ${cfg.keepAlive}); host patch ${s.patched ? "OK" : "MISSING — run patch/apply.mjs, then restart dsh"}`
		);
		const commands = ctx.get("commands", false);
		if (commands !== void 0 && commands !== null && typeof commands.register === "function") {
			commands.register("vision-bridge", {
				description: "Show vision-bridge patch/config status"
			}, () => {
				const st = status();
				const lines = st.targets.map((t) => `host patch ${t.patched ? "OK" : "MISSING"}: ${t.file}`);
				lines.push(`bridge model: ${cfg.model} @ ${cfg.baseURL} (keepAlive ${cfg.keepAlive})`);
				lines.push(`bridge config: ${st.configured ? (st.settingsSection ? "settings.yaml (vision-bridge:)" : st.legacyCfg) : "n/a (0.2.x profile row config)"}`);
				if (!st.patched) lines.push(`to repair: node "node_modules/dsh-ollama-vision-bridge/patch/apply.mjs" then restart dsh`);
				return lines.join("\n");
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
