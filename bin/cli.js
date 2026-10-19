#!/usr/bin/env node
/**
 * `npx` installer/status CLI for the Ollama vision bridge.
 *
 * This file intentionally imports only Node built-ins, so
 * `npx github:nvbb/dsh-ollama-vision-bridge setup` works before the plugin is
 * mounted into a DSH profile.
 *
 * Commands:
 *   setup            Validate the VL model, install the plugin, patch the
 *                    controller and write the `vision-bridge` profile config.
 *   model <name>     Point the bridge at another local Ollama VL model.
 *   status           Show the configured model / endpoint / keep_alive.
 *   check --model    Verify the model exists in the local Ollama instance.
 *
 * @module dsh-ollama-vision-bridge/cli
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const ENTRY_ID = "vision-bridge";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_KEEP_ALIVE = "60s";
const GITHUB_SPEC = "github:nvbb/dsh-ollama-vision-bridge";

const USAGE = `${pkg.name} ${pkg.version}

Usage:
  npx github:nvbb/dsh-ollama-vision-bridge setup --model <name> [options]
  npx github:nvbb/dsh-ollama-vision-bridge model <name> [options]
  npx github:nvbb/dsh-ollama-vision-bridge status [options]
  npx github:nvbb/dsh-ollama-vision-bridge check --model <name> [options]

Commands:
  setup     Validate the VL model, install the plugin into a profile, patch
            the chat admission, and write the vision-bridge config row.
  model     Switch the bridge to another local Ollama VL model (alias: set-model).
  status    Show the configured model / base URL / keep_alive (read-only).
  check     Query the local Ollama /api/tags and report whether the model exists.
  help      Show this help.

Options:
  --model <name>          Ollama VL model, e.g. qwen3-vl:8b or qwen3.8:27b-iq3s.
  --base-url <url>        Ollama endpoint. Default: ${DEFAULT_BASE_URL}.
  --keep-alive <value>    Ollama keep_alive, e.g. "60s", "10m", 0. Default: ${DEFAULT_KEEP_ALIVE}.
  --profile <name>        DSH profile name. Default: web.
  --plugin <spec>         Override the package spec passed to \`dsh plugin add\`.
  --skip-install          Only patch the profile; do not run dsh plugin add.
  --skip-apply            Do not run patch/apply.mjs.
  --apply                 (model) also run patch/apply.mjs.
  --no-check              Skip the Ollama model check.
  --probe                 (check) also run one real 1x1 PNG description.
  --profile-file <path>   Override cordis.patch.yml (tests/advanced).
  --dsh <path>            dsh executable. Default: dsh.
  -h, --help              Show this help.

Examples:
  npx github:nvbb/dsh-ollama-vision-bridge setup --model qwen3-vl:8b
  npx github:nvbb/dsh-ollama-vision-bridge model qwen3.8:27b-iq3s --keep-alive 10m
  npx github:nvbb/dsh-ollama-vision-bridge status --check
`;

class CliError extends Error {}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new CliError(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--model") options.model = value();
    else if (arg === "--base-url") options.baseURL = value();
    else if (arg === "--keep-alive") options.keepAlive = value();
    else if (arg === "--profile") options.profile = value();
    else if (arg === "--plugin") options.plugin = value();
    else if (arg === "--profile-file") options.profileFile = value();
    else if (arg === "--dsh") options.dsh = value();
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--skip-apply") options.skipApply = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--no-check") options.noCheck = true;
    else if (arg === "--probe") options.probe = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new CliError(`Unknown option ${arg}`);
    else options._.push(arg);
  }
  return options;
}

function profileName(options) {
  return options.profile ?? "web";
}

function profileFile(options) {
  if (options.profileFile !== undefined) return path.resolve(options.profileFile);
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", profileName(options), "cordis.patch.yml");
}

function quoteYaml(value) {
  if (/[\r\n]/u.test(value)) throw new CliError("YAML scalar values must not contain newlines");
  return "'" + value.replace(/'/gu, "''") + "'";
}

function unquoteYaml(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/gu, '"');
  }
  return trimmed;
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u);
}

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

function findBlock(lines, id) {
  const pattern = new RegExp("^- id:\\s*['\"]?" + id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "['\"]?\\s*$", "u");
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      let end = lines.length;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^- /u.test(lines[next])) {
          end = next;
          break;
        }
      }
      return { start: index, end };
    }
  }
  return undefined;
}

function setConfigValue(lines, block, key, value) {
  const keyPattern = new RegExp("^(\\s+)" + key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + ":\\s*(.*)$", "u");
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = keyPattern.exec(lines[index]);
    if (match !== null) {
      lines[index] = match[1] + key + ": " + value;
      return;
    }
  }
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = /^(\s+)config:\s*$/u.exec(lines[index]);
    if (match !== null) {
      lines.splice(index + 1, 0, match[1] + "  " + key + ": " + value);
      block.end += 1;
      return;
    }
  }
  const insertAt = block.end > block.start + 1 && lines[block.end - 1].trim().length === 0
    ? block.end - 1
    : block.end;
  lines.splice(insertAt, 0, "  config:", "    " + key + ": " + value);
  block.end += 2;
}

function addBlock(lines, id, config) {
  if (lines.length > 0 && lines[lines.length - 1].trim().length !== 0) lines.push("");
  lines.push("- id: " + id, "  config:");
  for (const [key, value] of Object.entries(config)) lines.push("    " + key + ": " + value);
  return { start: lines.length - Object.keys(config).length - 2, end: lines.length };
}

function getConfigValue(lines, id, key) {
  const block = findBlock(lines, id);
  if (block === undefined) return undefined;
  const pattern = new RegExp("^\\s+" + key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + ":\\s*(.*)$", "u");
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) return unquoteYaml(match[1]);
  }
  return undefined;
}

function readPatch(file) {
  if (!fs.existsSync(file)) {
    throw new CliError(`Profile patch not found: ${file}\nStart 'dsh --profile ${profileName({})}' once to initialize it, or pass --profile-file.`);
  }
  return readLines(file);
}

function backupPatch(file) {
  const stamp = new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  const backup = `${file}.bak-${stamp}-visioncli`;
  fs.copyFileSync(file, backup);
  return backup;
}

function patchProfile(options, model, baseURL, keepAlive) {
  const file = profileFile(options);
  const lines = readPatch(file);
  const backup = backupPatch(file);

  let block = findBlock(lines, ENTRY_ID);
  if (block === undefined) {
    block = addBlock(lines, ENTRY_ID, {
      model: quoteYaml(model),
      baseURL: quoteYaml(baseURL),
      keepAlive: quoteYaml(keepAlive)
    });
  } else {
    setConfigValue(lines, block, "model", quoteYaml(model));
    setConfigValue(lines, block, "baseURL", quoteYaml(baseURL));
    setConfigValue(lines, block, "keepAlive", quoteYaml(keepAlive));
  }

  writeLines(file, lines);
  return { file, backup };
}

function defaultPluginSpec() {
  const explicit = process.env.DSH_VISION_PLUGIN_SPEC;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const normalized = packageRoot.replace(/\\/gu, "/");
  const fromPackageCache = /\/_npx\/|\/node_modules\//u.test(normalized);
  if (!fromPackageCache) return "file:" + normalized;
  const repository = typeof pkg.repository?.url === "string" ? pkg.repository.url : "";
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/u.exec(repository);
  if (match !== null) return `github:${match[1]}/${match[2]}`;
  return GITHUB_SPEC;
}

function runInstall(options) {
  const spec = options.plugin ?? defaultPluginSpec();
  const dsh = options.dsh ?? "dsh";
  const args = ["plugin", "--profile", profileName(options), "add", spec];
  console.log(`[vision] ${dsh} ${args.join(" ")}`);
  const quote = (value) => '"' + String(value).replace(/"/gu, '""') + '"';
  const executable = /\s/u.test(dsh) ? quote(dsh) : dsh;
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [executable, ...args.map(quote)].join(" ")], {
      stdio: "inherit",
      cwd: process.cwd(),
    })
    : spawnSync(dsh, args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  if (result.error !== undefined && result.error !== null) {
    throw new CliError(`Could not run ${dsh}: ${result.error.message}. Stop 'dsh web' first and make sure dsh is on PATH.`);
  }
  if (result.status !== 0) {
    throw new CliError(`dsh plugin add failed with exit ${String(result.status)}. Stop 'dsh web' and retry.`);
  }
}

function runApply(options) {
  const script = path.join(packageRoot, "patch", "apply.mjs");
  console.log(`[vision] node ${script}`);
  const result = spawnSync(process.execPath, [script], { stdio: "inherit", cwd: process.cwd() });
  if (result.error !== undefined && result.error !== null) {
    throw new CliError(`Could not run ${script}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CliError("patch/apply.mjs failed — see messages above");
  }
}

function normalizeBaseURL(raw) {
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError(`Invalid base URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("Base URL must be http(s)");
  if (url.username !== "" || url.password !== "") throw new CliError("Base URL must not contain credentials");
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/u, "");
}

async function fetchModelNames(baseURL) {
  let response;
  try {
    response = await fetch(`${baseURL}/api/tags`, {
      signal: AbortSignal.timeout(12000),
      headers: { "user-agent": `${pkg.name}/${pkg.version}` },
    });
  } catch (error) {
    throw new CliError(`Ollama not reachable at ${baseURL} (${error instanceof Error ? error.message : String(error)}). Start the Ollama app first.`);
  }
  if (!response.ok) throw new CliError(`Ollama /api/tags returned HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.models) ? payload.models.map((entry) => String(entry.name ?? "")) : [];
}

async function validateModel(baseURL, model) {
  const names = await fetchModelNames(baseURL);
  const match = names.some((name) => name === model || name === `${model}:latest` || name.startsWith(`${model}:`));
  if (!match) {
    throw new CliError(`Model "${model}" is not present in Ollama at ${baseURL}.\nAvailable: ${names.join(", ") || "(none)"}\nPull it first (ollama pull ${model}) or pick an installed VL model.`);
  }
  console.log(`[vision] model OK: ${model} (${baseURL})`);
}

const PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function probeModel(baseURL, model, keepAlive) {
  let response;
  try {
    response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(300000),
      headers: { "content-type": "application/json", "user-agent": `${pkg.name}/${pkg.version}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image." },
              { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PNG}` } },
            ],
          },
        ],
        stream: false,
        keep_alive: keepAlive,
        temperature: 0.2,
        max_tokens: 64,
      }),
    });
  } catch (error) {
    throw new CliError(`Description probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new CliError(`Description probe returned HTTP ${response.status} — is ${model} a vision (VL) model?`);
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") throw new CliError("Description probe returned an empty answer");
  console.log(`[vision] probe OK: ${text.trim().slice(0, 80)}`);
}

function gatherOptions(options, fallbackModel) {
  const model = options.model ?? fallbackModel ?? options._[1];
  if (model === undefined || model.length === 0) {
    throw new CliError("Missing --model. Usage: setup --model qwen3-vl:8b");
  }
  const baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
  const keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE;
  return { model, baseURL, keepAlive };
}

async function commandSetup(options) {
  const { model, baseURL, keepAlive } = gatherOptions(options);
  if (options.noCheck !== true) await validateModel(baseURL, model);
  if (options.skipInstall !== true) runInstall(options);
  if (options.skipApply !== true) runApply(options);
  const { file, backup } = patchProfile(options, model, baseURL, keepAlive);
  console.log(`[vision] patched ${file}`);
  console.log(`[vision] backup: ${backup}`);
  console.log(`[vision] bridge model: ${model} @ ${baseURL} (keepAlive ${keepAlive})`);
  console.log("[vision] restart dsh web to load the patched controller");
}

async function commandModel(options) {
  const { model, baseURL, keepAlive } = gatherOptions(options);
  if (options.noCheck !== true) await validateModel(baseURL, model);
  const { file, backup } = patchProfile(options, model, baseURL, keepAlive);
  console.log(`[vision] patched ${file}`);
  console.log(`[vision] backup: ${backup}`);
  console.log(`[vision] bridge model: ${model} @ ${baseURL} (keepAlive ${keepAlive})`);
  if (options.apply === true) {
    runApply(options);
    console.log("[vision] restart dsh web to load the patched controller");
  } else {
    console.log("[vision] restart dsh web to apply the new model (controller patch unchanged)");
  }
}

async function commandStatus(options) {
  const file = profileFile(options);
  const lines = readPatch(file);
  const model = getConfigValue(lines, ENTRY_ID, "model") ?? "(unset)";
  const baseURL = getConfigValue(lines, ENTRY_ID, "baseURL") ?? DEFAULT_BASE_URL;
  const keepAlive = getConfigValue(lines, ENTRY_ID, "keepAlive") ?? DEFAULT_KEEP_ALIVE;
  console.log(`[vision] profile: ${file}`);
  console.log(`[vision] model: ${model}`);
  console.log(`[vision] baseURL: ${baseURL}`);
  console.log(`[vision] keepAlive: ${keepAlive}`);
  if (options.check === true && model !== "(unset)") {
    const normalized = normalizeBaseURL(baseURL);
    if (options.probe === true) await probeModel(normalized, model, keepAlive);
    else await validateModel(normalized, model);
  }
}

async function commandCheck(options) {
  const modelArg = options.model ?? options._[1];
  if (modelArg === undefined || modelArg.length === 0) {
    throw new CliError("Missing --model. Usage: check --model qwen3-vl:8b");
  }
  const baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
  await validateModel(baseURL, modelArg);
  if (options.probe === true) await probeModel(baseURL, modelArg, options.keepAlive ?? DEFAULT_KEEP_ALIVE);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? (options.help ? "help" : "setup");
  if (options.help === true || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "setup") return commandSetup(options);
  if (command === "model" || command === "set-model") return commandModel(options);
  if (command === "status") return commandStatus(options);
  if (command === "check") return commandCheck(options);
  throw new CliError(`Unknown command "${command}". Run with --help.`);
}

main().catch((error) => {
  const message = error instanceof CliError ? error.message : (error instanceof Error ? error.message : String(error));
  console.error(`[vision] ERROR: ${message}`);
  process.exitCode = 1;
});
