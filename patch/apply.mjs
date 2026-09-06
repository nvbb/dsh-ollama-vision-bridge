#!/usr/bin/env node
/**
 * dsh-ollama-vision-bridge — installer / re-applier (DSH >= 0.1.2-rc.1).
 *
 * One command performs the whole setup against $DSH_HOME (default ~/.dsh):
 *
 *   1. Patch the chat prompt admission in
 *      @deepseek-ai/dsh-api-session-controller — the Web GUI runtime bundle
 *      (lib/index.js) and its separate compile output
 *      (lib/types/commands.js) — so a text-only chat model receives a VL
 *      description of attached images from a local Ollama model (idempotent;
 *      a patch marker skips re-application). The request carries Ollama
 *      keep_alive so the VL model unloads from VRAM after the idle window.
 *   2. Append the `llm-pi-ai` provider section to settings.yaml (skipped if a
 *      section already exists).
 *   3. Write vision-bridge.yaml when absent (existing file is preserved).
 *   4. Report OLLAMA_MODELS / model visibility so a fresh machine gets the
 *      right hint.
 *
 * Usage:
 *   node patch/apply.mjs                 # normal: targets $DSH_HOME
 *   node patch/apply.mjs --file <path>   # test one target against a copy
 *   node patch/apply.mjs --check         # only report status, change nothing
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ANCHOR_MULTI,
	ANCHOR_SINGLE,
	BRIDGE_CONFIG_DEFAULT,
	HELPERS_LINES,
	MARKER,
	SETTINGS_SECTION,
	TARGET_REL
} from "./source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, "..");

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function log(line) {
	process.stdout.write(`[dsh-ollama-vision-bridge] ${line}\n`);
}

function indentUnit(ws) {
	return ws.startsWith("\t") ? "\t" : "    ";
}

/**
 * Rewrite the single-line refusal `if (cond) throw new RemoteError(...);`
 * (index.js bundle style) or the multi-line refusal block (commands.js style)
 * into `if (cond) { bridge; null -> original throw; return accepted; }`.
 * Returns { ok, reason } — ok=true when patched or already patched.
 */
function patchRefusal(lines) {
	for (let i = 0; i < lines.length; i++) {
		const single = ANCHOR_SINGLE.exec(lines[i]);
		if (single) {
			const ws = single[1];
			const stmt = single[2];
			const iws = ws + indentUnit(ws);
			const rep = [
				`${ws}if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) {`,
				`${iws}const bridged = await dshOllamaAdmit(this, agent, current.model, request.content, source, request.mode);`,
				`${iws}if (bridged === null) ${stmt}`,
				`${iws}return { accepted: true };`,
				`${ws}}`
			];
			lines.splice(i, 1, ...rep);
			return { ok: true, style: "single" };
		}
		const multi = ANCHOR_MULTI.exec(lines[i]);
		if (multi) {
			const next = lines[i + 1];
			const after = lines[i + 2];
			if (next !== void 0 && /^\s*throw new RemoteError\(/.test(next) && after !== void 0 && after.trim() === "}") {
				const ws = multi[1];
				const iws = ws + indentUnit(ws);
				const throwLine = next.trim();
				const rep = [
					lines[i],
					`${iws}const bridged = await dshOllamaAdmit(this, agent, current.model, request.content, source, request.mode);`,
					`${iws}if (bridged === null) ${throwLine}`,
					`${iws}return { accepted: true };`,
					after
				];
				lines.splice(i, 3, ...rep);
				return { ok: true, style: "multi" };
			}
			return { ok: false, reason: "anchor-multi-malformed" };
		}
	}
	return { ok: false, reason: "anchors-not-found" };
}

const REGION_CALL = "const bridged = await dshOllamaAdmit(this, agent, current.model, request.content, source, request.mode);";

function hasRefusalAnchor(text) {
	return ANCHOR_SINGLE.test(text) || ANCHOR_MULTI.test(text);
}

/** Patch one copy of dsh-api-session-controller's prompt admission. */
function patchController(file) {
	if (!existsSync(file)) {
		log(`target not found: ${file}`);
		log("is this a dsh web profile machine? (expected at $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/...)");
		return { ok: false, reason: "target-not-found" };
	}
	const text = readFileSync(file, "utf8");
	if (text.includes(REGION_CALL)) {
		if (!text.includes(MARKER)) {
			// region already bridged from an earlier run, helpers missing — repair helpers only
			writeFileSync(file, `${text}${text.endsWith("\n") ? "" : "\n"}\n${HELPERS_LINES.join("\n")}\n`, "utf8");
			log(`helpers appended (${file})`);
		} else {
			log(`already patched (${file})`);
		}
		return { ok: true, already: true };
	}
	if (!hasRefusalAnchor(text)) {
		log(`refusal anchor not found in ${file}`);
		log("this dsh version changed its internals — update dsh-ollama-vision-bridge (expected DSH >= 0.1.2-rc.1 prompt handler in @deepseek-ai/dsh-api-session-controller)");
		return { ok: false, reason: "anchors-not-found" };
	}

	let lines = text.split(/\r?\n/);
	const spliced = patchRefusal(lines);
	if (!spliced.ok) {
		log(`refusal anchor could not be rewritten in ${file}: ${spliced.reason}`);
		return { ok: false, reason: spliced.reason };
	}

	let out = lines.join("\n");
	if (!out.includes(MARKER)) {
		const sep = out.endsWith("\n") ? "" : "\n";
		out = `${out}${sep}\n${HELPERS_LINES.join("\n")}\n`;
	}

	const tmp = `${file}.dsh-tmp`;
	writeFileSync(tmp, out, "utf8");
	renameSync(tmp, file);
	log(`patched ${file} (${spliced.style} refusal form + helpers)`);
	return { ok: true };
}

function writeSettings(home) {
	const file = join(home, "settings.yaml");
	if (!existsSync(file)) {
		log(`settings.yaml not found at ${file} — skipping llm-pi-ai section (create it or run dsh once)`);
		return false;
	}
	const text = readFileSync(file, "utf8");
	if (/^llm-pi-ai:/m.test(text)) {
		log("settings.yaml already has an llm-pi-ai section — leaving it untouched");
		return true;
	}
	const out = `${text.replace(/\s+$/, "")}\n${SETTINGS_SECTION}\n`;
	writeFileSync(file, out, "utf8");
	log(`appended llm-pi-ai section to ${file}`);
	return true;
}

function writeBridgeConfig(home) {
	const file = join(home, "vision-bridge.yaml");
	if (existsSync(file)) {
		log(`vision-bridge.yaml already exists — leaving it untouched (${file})`);
		return true;
	}
	writeFileSync(file, BRIDGE_CONFIG_DEFAULT, "utf8");
	log(`wrote ${file}`);
	return true;
}

function walk(dir) {
	const out = [];
	const read = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) read(full);
			else out.push(full);
		}
	};
	read(dir);
	return out;
}

function checkOllama(home) {
	const env = process.env.OLLAMA_MODELS;
	const candidates = env ? [env] : [join(homedir(), ".ollama", "models")];
	const manifests = [];
	for (const dir of candidates) {
		const m = join(dir, "manifests");
		if (existsSync(m)) manifests.push(m);
	}
	const found = manifests.some((m) => {
		const names = walk(m);
		return names.some((n) => /qwen3-vl|qwen2\.5vl|llava|minicpm|llama3\.2-vision|moondream|gemma/.test(n.toLowerCase()));
	});
	if (found) {
		log("Ollama VL model manifest found under OLLAMA_MODELS — good");
		return true;
	}
	log("hint: no VL model manifest found under OLLAMA_MODELS" + (env ? ` (current OLLAMA_MODELS=${env})` : " (unset; default ~/.ollama/models)"));
	log("if your models live elsewhere, set the user env var OLLAMA_MODELS to that directory and restart Ollama");
	log("then: ollama pull qwen3-vl:8b  (or import your own GGUF + Modelfile)");
	return false;
}

function syntaxCheck(file) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function targetFile(home, rel) {
	return join(home, "profiles", "node_modules", "@deepseek-ai", ...rel);
}

function main() {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");
	const fileIdx = args.indexOf("--file");
	const home = dshHome();
	log(`DSH_HOME = ${home}`);
	log(`package dir = ${PACKAGE_DIR}`);

	const targets = [];
	if (fileIdx >= 0 && args[fileIdx + 1]) {
		targets.push(resolve(args[fileIdx + 1]));
		log(`single-file test mode: ${targets[0]}`);
	} else {
		for (const rel of TARGET_REL) targets.push(targetFile(home, rel));
		log(`controller targets:\n${targets.map((t) => `  - ${t}`).join("\n")}`);
	}

	if (checkOnly) {
		for (const target of targets) {
			const text = existsSync(target) ? readFileSync(target, "utf8") : "";
			const patched = text.includes(REGION_CALL) && text.includes(MARKER);
			log(`${patched ? "patched" : "NOT patched"}: ${target}`);
		}
		log(`bridge config: ${existsSync(join(home, "vision-bridge.yaml")) ? "present (legacy)" : "missing (legacy)"}`);
		log(`bridge section: ${existsSync(join(home, "settings.yaml")) && /^vision-bridge:/m.test(readFileSync(join(home, "settings.yaml"), "utf8")) ? "present (settings.yaml)" : "missing"}`);
		return;
	}

	let ok = true;
	for (const target of targets) {
		const result = patchController(target);
		if (result.ok && !result.already) {
			if (!syntaxCheck(target)) {
				log(`!! patched file failed node --check — restore/review target: ${target}`);
				ok = false;
			} else {
				log(`patched file passed node --check (${target})`);
			}
		}
		if (!result.ok) ok = false;
	}

	if (ok && fileIdx < 0) {
		writeSettings(home);
		writeBridgeConfig(home);
		checkOllama(home);
	}

	log(ok ? "done. restart dsh (stop the old process first: the one listening on its port) to load the patch."
		: "setup incomplete — see messages above.");
	process.exit(ok ? 0 : 1);
}

main();
