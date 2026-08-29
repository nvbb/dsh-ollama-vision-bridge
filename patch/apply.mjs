#!/usr/bin/env node
/**
 * dsh-ollama-vision-bridge — installer / re-applier.
 *
 * One command performs the whole setup against $DSH_HOME (default
 * ~/.dsh):
 *
 *   1. Patch @deepseek-ai/dsh-host-apiproxy/lib/index.js so a text-only chat
 *      model receives a VL description of attached images (idempotent; a
 *      patch marker skips re-application). The request carries Ollama
 *      keep_alive so the VL model unloads from VRAM after the idle window.
 *   2. Append the `llm-pi-ai` provider section to settings.yaml (skipped if a
 *      section already exists).
 *   3. Write vision-bridge.yaml when absent (existing file is preserved).
 *   4. Report OLLAMA_MODELS / model visibility so a fresh machine gets the
 *      right hint.
 *
 * Usage:
 *   node patch/apply.mjs                 # normal: targets $DSH_HOME
 *   node patch/apply.mjs --file <path>   # test against a copy
 *   node patch/apply.mjs --check         # only report status, change nothing
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ANCHOR_DURABLE_PROMPT,
	ANCHOR_REFUSAL,
	BRIDGE_CONFIG_DEFAULT,
	HELPER_LINES,
	MARKER,
	REFUSAL_REPLACEMENT_LINES,
	SETTINGS_SECTION
} from "./source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, "..");

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function apiProxyFile(home) {
	return join(home, "profiles", "node_modules", "@deepseek-ai", "dsh-host-apiproxy", "lib", "index.js");
}

function log(line) {
	process.stdout.write(`[dsh-ollama-vision-bridge] ${line}\n`);
}

function patchApiProxy(file) {
	if (!existsSync(file)) {
		log(`target not found: ${file}`);
		log("is this a dsh web profile machine? (expected at $DSH_HOME/profiles/node_modules/...)");
		return { ok: false, reason: "target-not-found" };
	}
	const text = readFileSync(file, "utf8");
	if (text.includes(MARKER)) {
		log(`host patch already applied (${file})`);
		return { ok: true, already: true };
	}
	const lines = text.split(/\r?\n/);

	const anchorIdx = lines.findIndex((line) => line.startsWith(ANCHOR_DURABLE_PROMPT));
	if (anchorIdx < 0) {
		log(`anchor not found: ${ANCHOR_DURABLE_PROMPT}`);
		log("this dsh version changed its internals — update dsh-ollama-vision-bridge");
		return { ok: false, reason: "anchor-durable-prompt-not-found" };
	}
	const refIdx = lines.findIndex((line) => ANCHOR_REFUSAL.test(line));
	if (refIdx < 0) {
		log("refusal anchor not found in the prompt RPC handler");
		log("this dsh version changed its internals — update dsh-ollama-vision-bridge");
		return { ok: false, reason: "anchor-refusal-not-found" };
	}

	lines.splice(anchorIdx, 0, ...HELPER_LINES);
	// re-find the refusal index after the insertion shifted line numbers
	const refIdx2 = lines.findIndex((line) => ANCHOR_REFUSAL.test(line));
	lines.splice(refIdx2, 5, ...REFUSAL_REPLACEMENT_LINES);

	const out = lines.join("\n");
	const tmp = `${file}.dsh-tmp`;
	writeFileSync(tmp, out, "utf8");
	renameSync(tmp, file);
	log(`patched ${file}`);
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

function walk(dir) {
	const out = [];
	const read = (d) => {
		let entries;
		try {
			entries = readdirSafe(d);
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

function readdirSafe(dir) {
	return readdirSync(dir, { withFileTypes: true });
}

function syntaxCheck(file) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function main() {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");
	const fileIdx = args.indexOf("--file");
	const home = dshHome();
	log(`DSH_HOME = ${home}`);
	log(`package dir = ${PACKAGE_DIR}`);

	const target = fileIdx >= 0 && args[fileIdx + 1] ? resolve(args[fileIdx + 1]) : apiProxyFile(home);
	log(`apiproxy target = ${target}`);

	if (checkOnly) {
		const patched = existsSync(target) && readFileSync(target, "utf8").includes(MARKER);
		log(`host patch: ${patched ? "applied" : "NOT applied"}`);
		log(`bridge config: ${existsSync(join(home, "vision-bridge.yaml")) ? "present" : "missing"}`);
		return;
	}

	let ok = true;
	const patchResult = patchApiProxy(target);
	if (patchResult.ok && !patchResult.already) {
		if (!syntaxCheck(target)) {
			log("!! patched file failed node --check — restoring nothing (review target)");
			ok = false;
		} else {
			log("patched file passed node --check");
		}
	}
	if (!patchResult.ok) ok = false;

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
