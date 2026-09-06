/**
 * dsh-ollama-vision-bridge — runtime companion.
 *
 * The functional part of this plugin is the install-time patcher
 * (patch/apply.mjs): it patches the chat prompt admission in
 * @deepseek-ai/dsh-api-session-controller (DSH >= 0.1.2-rc.1) so a text-only
 * chat model receives a VL description of attached images, writes the
 * `llm-pi-ai` provider section into settings.yaml, and writes
 * vision-bridge.yaml.
 *
 * This module is a minimal Cordis row that reports patch/config status at
 * boot and offers a `vision-bridge` status command when the commands service
 * is available. It is deliberately defensive: it never throws, so mounting or
 * removing it can never break a profile boot.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const name = "vision-bridge";
const MARKER = "DSH OLLAMA VISION BRIDGE PATCH v2";

/** Files the install-time patcher touches, relative to the controller package lib/. */
const TARGETS = ["index.js", "types/commands.js"];

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

function apply(ctx) {
	try {
		const s = status();
		if (s.patched) {
			ctx.logger.info(`vision-bridge: host patch OK (${s.targets.length}/${s.targets.length}); config ${s.configured ? "present" : "MISSING (run patch/apply.mjs)"}`);
		} else if (s.anyPatched) {
			ctx.logger.warn(`vision-bridge: host patch INCOMPLETE — run: node "node_modules/dsh-ollama-vision-bridge/patch/apply.mjs" and restart dsh`);
		} else {
			ctx.logger.warn(`vision-bridge: dsh-api-session-controller is NOT patched — run: node "node_modules/dsh-ollama-vision-bridge/patch/apply.mjs" and restart dsh`);
		}
		const commands = ctx.get("commands", false);
		if (commands !== void 0 && commands !== null && typeof commands.register === "function") {
			commands.register("vision-bridge", {
				description: "Show vision-bridge patch/config status"
			}, () => {
				const st = status();
				const lines = st.targets.map((t) => `host patch ${t.patched ? "OK" : "MISSING"}: ${t.file}`);
				lines.push(`bridge config: ${st.configured ? (st.settingsSection ? "settings.yaml (vision-bridge:)" : st.legacyCfg) : "MISSING"}`);
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

export { apply, name };
