/**
 * dsh-ollama-vision-bridge — runtime companion.
 *
 * The functional part of this plugin is the install-time patcher
 * (patch/apply.mjs): it patches @deepseek-ai/dsh-host-apiproxy so that a
 * text-only chat model receives a VL description of attached images, writes
 * the `llm-pi-ai` provider section into settings.yaml, and writes
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
const MARKER = "VISION BRIDGE PATCH";

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function status() {
	const apiProxy = join(dshHome(), "profiles", "node_modules", "@deepseek-ai", "dsh-host-apiproxy", "lib", "index.js");
	const bridgeCfg = join(dshHome(), "vision-bridge.yaml");
	let patched = false;
	try {
		patched = existsSync(apiProxy) && readFileSync(apiProxy, "utf8").includes(MARKER);
	} catch {
		patched = false;
	}
	return {
		patched,
		apiProxy,
		bridgeCfg,
		configured: existsSync(bridgeCfg)
	};
}

function apply(ctx) {
	try {
		const s = status();
		if (s.patched) {
			ctx.logger.info(`vision-bridge: host patch OK; config ${s.configured ? "present" : "MISSING (run patch/apply.mjs)"} (${s.bridgeCfg})`);
		} else {
			ctx.logger.warn(`vision-bridge: dsh-host-apiproxy is NOT patched — run: node "node_modules/dsh-ollama-vision-bridge/patch/apply.mjs" and restart dsh`);
		}
		const commands = ctx.get("commands", false);
		if (commands !== void 0 && commands !== null && typeof commands.register === "function") {
			commands.register("vision-bridge", {
				description: "Show vision-bridge patch/config status"
			}, () => {
				const s = status();
				return [
					`host patch: ${s.patched ? "OK" : "MISSING"}`,
					`bridge config: ${s.configured ? s.bridgeCfg : "MISSING"}`,
					s.patched ? "to reconfigure: edit " + s.bridgeCfg + " then restart dsh" : `to repair: node "node_modules/dsh-ollama-vision-bridge/patch/apply.mjs" then restart dsh`
				].join("\n");
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
