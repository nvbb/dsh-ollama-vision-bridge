/**
 * dsh-ollama-vision-bridge — patch source of truth (DSH >= 0.1.2-rc.1).
 *
 * DSH 0.1.2-rc.1 removed @deepseek-ai/dsh-host-apiproxy and moved the chat
 * prompt admission into @deepseek-ai/dsh-api-session-controller:
 *
 *   - lib/index.js          (runtime bundle; the Web GUI chat path)
 *   - lib/types/commands.js (same business class, separate compile output)
 *
 * In both copies the image-modality refusal lives in the `prompt` RPC handler:
 *
 *   if (hasImage) {
 *     const current = this.agents.selectionFor(agent).current;
 *     const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
 *     if (model.inputModalities !== ... && !model.inputModalities.includes("image"))
 *       throw new RemoteError("session/attachment-invalid", ..., { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
 *   }
 *
 * patch/apply.mjs rewrites that refusal into:
 *
 *   if (model.inputModalities !== ... && !model.inputModalities.includes("image")) {
 *     const bridged = await dshOllamaAdmit(this, agent, current.model, request.content, source, request.mode);
 *     if (bridged === null) throw new RemoteError(...);   // bridge off/unavailable -> native refusal
 *     return { accepted: true };                          // bridge admitted the prompt
 *   }
 *
 * and appends the module-scope helpers below (HELPERS_LINES) to the same file.
 * The helpers admit the images durably (history keeps them), describe each via
 * a local Ollama VL model (keep_alive VRAM cooling), enqueue the user's own
 * message unchanged (one send -> one response) and stage the description for
 * an agent/pre-step waterfall so the SAME model step that answers also
 * receives the description. DSH 0.1.2 projects image blocks in text-only model
 * requests into "[image omitted …]" placeholders on its own, so the durable
 * user message with image references never reaches the text adapter.
 */

/** Marker placed inside the appended helper block; re-apply skips when present. */
export const MARKER = "DSH OLLAMA VISION BRIDGE PATCH v2";

/** Package-relative patch targets under $DSH_HOME/profiles/node_modules/@deepseek-ai/. */
export const TARGET_REL = [
	["dsh-api-session-controller", "lib", "index.js"],
	["dsh-api-session-controller", "lib", "types", "commands.js"]
];

/**
 * Refusal-statement anchors, one per compile style.
 *
 * index.js (bundle): tabs, `void 0`, double quotes, single-line if/throw.
 * types/commands.js: 4-space indent, `undefined`, single quotes, block form.
 */
export const ANCHOR_SINGLE = /^(\s*)if \(model\.inputModalities !== void 0 && !model\.inputModalities\.includes\("image"\)\) (throw new RemoteError\("session\/attachment-invalid", `Model "\$\{current\.model\}" does not support image input\.`, \{ reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" \}\);)$/m;

export const ANCHOR_MULTI = /^(\s*)if \(model\.inputModalities !== undefined && !model\.inputModalities\.includes\('image'\)\) \{$/m;

/**
 * Module-scope helpers appended at the end of the patched file (function
 * declarations are hoisted, so the region splice above can call them). The
 * text is written to be independent of the surrounding file's indent style.
 */
export const HELPERS_LINES = [
	"/** DSH OLLAMA VISION BRIDGE PATCH v2 (dsh-ollama-vision-bridge).",
	" * When the selected chat model is text-only and the user attaches images,",
	" * dshOllamaAdmit() durably admits the images (history keeps them), asks the",
	" * local Ollama VL model for a short description of each, enqueues the user's",
	" * own message unchanged (one send => one response) and stages the description",
	" * for the agent/pre-step waterfall so the SAME model step that answers also",
	" * receives the description. Bridge unavailable => returns null so callers",
	" * keep the DSH-native refusal. */",
	"const dshOllamaPendingNotes = /* @__PURE__ */ new WeakMap();",
	"const dshOllamaAgentHooks = /* @__PURE__ */ new WeakSet();",
	"",
	"async function dshOllamaBridgeConfig() {",
	"\tconst envBase = process.env.DSH_VISION_BRIDGE_BASE_URL;",
	"\tconst envModel = process.env.DSH_VISION_BRIDGE_MODEL;",
	"\tconst envKeep = process.env.DSH_VISION_BRIDGE_KEEP_ALIVE;",
	"\tif (envBase !== void 0 || envModel !== void 0) {",
	"\t\tif (typeof envModel !== \"string\" || envModel === \"\") return null;",
	"\t\treturn { baseURL: typeof envBase === \"string\" && envBase !== \"\" ? envBase : \"http://127.0.0.1:11434\", model: envModel, keepAlive: typeof envKeep === \"string\" && envKeep !== \"\" ? envKeep : \"60s\" };",
	"\t}",
	"\ttry {",
	"\t\tconst { readFile } = await import(\"node:fs/promises\");",
	"\t\tconst { join } = await import(\"node:path\");",
	"\t\tconst { homedir } = await import(\"node:os\");",
	"\t\tconst yaml = await import(\"js-yaml\");",
	"\t\tconst home = process.env.DSH_HOME ?? join(homedir(), \".dsh\");",
	"\t\tlet doc = null;",
	"\t\ttry {",
	"\t\t\tconst settingsText = await readFile(join(home, \"settings.yaml\"), \"utf8\");",
	"\t\t\tconst settingsDoc = yaml.load(settingsText);",
	"\t\t\tif (settingsDoc !== null && typeof settingsDoc === \"object\" && settingsDoc[\"vision-bridge\"] !== void 0) doc = settingsDoc[\"vision-bridge\"];",
	"\t\t} catch {",
	"\t\t\t// no settings document",
	"\t\t}",
	"\t\tif (doc === null) {",
	"\t\t\t// fallback: legacy standalone vision-bridge.yaml",
	"\t\t\ttry {",
	"\t\t\t\tdoc = yaml.load(await readFile(join(home, \"vision-bridge.yaml\"), \"utf8\"));",
	"\t\t\t} catch {",
	"\t\t\t\t// absent",
	"\t\t\t}",
	"\t\t}",
	"\t\tif (doc !== null && typeof doc === \"object\" && doc.enabled !== false) {",
	"\t\t\tconst model = typeof doc.model === \"string\" && doc.model !== \"\" ? doc.model : void 0;",
	"\t\t\tif (model !== void 0) {",
	"\t\t\t\treturn {",
	"\t\t\t\t\tbaseURL: typeof doc.baseURL === \"string\" && doc.baseURL !== \"\" ? doc.baseURL : \"http://127.0.0.1:11434\",",
	"\t\t\t\t\tmodel,",
	"\t\t\t\t\tmodels: typeof doc.models === \"object\" && doc.models !== null ? doc.models : void 0,",
	"\t\t\t\t\tkeepAlive: typeof doc.keepAlive === \"string\" ? doc.keepAlive : typeof doc.keepAlive === \"number\" ? doc.keepAlive : \"60s\",",
	"\t\t\t\t\tprompt: typeof doc.prompt === \"string\" ? doc.prompt : void 0,",
	"\t\t\t\t\ttimeoutMs: Number.isFinite(doc.timeoutMs) ? doc.timeoutMs : 300000",
	"\t\t\t\t};",
	"\t\t\t}",
	"\t\t}",
	"\t} catch {",
	"\t\t// bridge config unreadable or absent; bridge stays off",
	"\t}",
	"\treturn null;",
	"}",
	"",
	"/** Ask the local Ollama VL model to describe one base64 data-URI image. */",
	"async function dshOllamaDescribe(cfg, dataUri) {",
	"\tconst base = String(cfg.baseURL).replace(/\\/v1\\/?$/, \"\");",
	"\tconst prompt = cfg.prompt ?? \"\\u8bf7\\u7528\\u4e2d\\u6587\\u7b80\\u8981\\u3001\\u51c6\\u786e\\u5730\\u63cf\\u8ff0\\u8fd9\\u5f20\\u56fe\\u7247\\u7684\\u5185\\u5bb9\\uff0c\\u5305\\u62ec\\u4e3b\\u8981\\u5143\\u7d20\\u3001\\u6587\\u5b57\\u3001\\u5e03\\u5c40\\u4e0e\\u5173\\u7cfb\\u3002\\u63a7\\u5236\\u5728200\\u5b57\\u4ee5\\u5185\\u3002\";",
	"\tconst payload = {",
	"\t\tmodel: cfg.model,",
	"\t\tmessages: [{ role: \"user\", content: [",
	"\t\t\t{ type: \"text\", text: prompt },",
	"\t\t\t{ type: \"image_url\", image_url: { url: dataUri } }",
	"\t\t] }],",
	"\t\tstream: false,",
	"\t\tkeep_alive: cfg.keepAlive ?? \"60s\",",
	"\t\ttemperature: 0.2,",
	"\t\tmax_tokens: 512",
	"\t};",
	"\ttry {",
	"\t\tconst resp = await fetch(`${base}/v1/chat/completions`, {",
	"\t\t\tmethod: \"POST\",",
	"\t\t\theaders: { \"Content-Type\": \"application/json\" },",
	"\t\t\tbody: JSON.stringify(payload),",
	"\t\t\tsignal: AbortSignal.timeout(cfg.timeoutMs ?? 300000)",
	"\t\t});",
	"\t\tif (!resp.ok) return null;",
	"\t\tconst body = await resp.json();",
	"\t\tconst text = body?.choices?.[0]?.message?.content;",
	"\t\treturn typeof text === \"string\" && text.trim() !== \"\" ? text.trim() : null;",
	"\t} catch {",
	"\t\treturn null;",
	"\t}",
	"}",
	"",
	"/**",
	" * Admit one image-carrying prompt for a text-only model via the local Ollama",
	" * VL model. Returns true after enqueueing the user message (durable content,",
	" * image references kept for history) and staging the description for the",
	" * agent/pre-step hook; returns null when the bridge is off or cannot serve,",
	" * so callers keep the DSH-native refusal. Attachment admission errors are",
	" * deliberately NOT caught here: the caller's catch maps AttachmentError to",
	" * session/attachment-invalid just like the native path. */",
	"async function dshOllamaAdmit(controller, agent, currentModel, content, source, mode) {",
	"\tlet cfg = null;",
	"\ttry {",
	"\t\tcfg = await dshOllamaBridgeConfig();",
	"\t} catch {",
	"\t\tcfg = null;",
	"\t}",
	"\tif (cfg === null) return null;",
	"\tconst model = cfg.models !== void 0 && typeof currentModel === \"string\" && typeof cfg.models[currentModel] === \"string\" && cfg.models[currentModel] !== \"\" ? cfg.models[currentModel] : cfg.model;",
	"\tconst durable = await admitPromptContent(controller.ctx.attachments, content);",
	"\tconst notes = [];",
	"\tfor (const block of durable) {",
	"\t\tif (block.type !== \"image\") continue;",
	"\t\tlet desc = null;",
	"\t\ttry {",
	"\t\t\tconst stored = await controller.ctx.attachments.readImage(block.attachment);",
	"\t\t\tconst dataUri = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString(\"base64\")}`;",
	"\t\t\tdesc = await dshOllamaDescribe({ ...cfg, model }, dataUri);",
	"\t\t} catch {",
	"\t\t\tdesc = null;",
	"\t\t}",
	"\t\tif (desc === null) return null;",
	"\t\tnotes.push(desc);",
	"\t}",
	"\tconst message = createUserMessage({ content: durable, source });",
	"\tif (mode === \"steer\") agent.steer(message);",
	"\telse agent.followup(message);",
	"\tif (notes.length > 0) {",
	"\t\tdshOllamaInstallNoteHook(agent);",
	"\t\tdshOllamaPendingNotes.set(agent, `[\\u56fe\\u7247\\u8bf4\\u660e\\uff08\\u672c\\u5730\\u89c6\\u89c9\\u6a21\\u578b ${model} \\u751f\\u6210\\uff09]\\n${notes.join(\"\\n\\n\")}\\n\\n\\uff08\\u7cfb\\u7edf\\u8bf4\\u660e\\uff1a\\u7528\\u6237\\u9644\\u52a0\\u4e86\\u56fe\\u7247\\u3002\\u5f53\\u524d\\u6a21\\u578b\\u4e0d\\u652f\\u6301\\u539f\\u751f\\u56fe\\u7247\\u8bc6\\u522b\\uff0c\\u4ee5\\u4e0a\\u63cf\\u8ff0\\u7531\\u672c\\u5730\\u89c6\\u89c9\\u6a21\\u578b ${model} \\u751f\\u6210\\u3002\\u8bf7\\u5728\\u56de\\u7b54\\u5f00\\u5934\\u7b80\\u8981\\u8bf4\\u660e\\u8fd9\\u4e00\\u70b9\\uff0c\\u7136\\u540e\\u57fa\\u4e8e\\u56fe\\u7247\\u5185\\u5bb9\\u56de\\u7b54\\u7528\\u6237\\u7684\\u95ee\\u9898\\u3002\\uff09`)",
	"\t}",
	"\treturn true;",
	"}",
	"",
	"/** Install (once per agent) an agent/pre-step waterfall listener that appends",
	" * the pending vision note to the SAME step as the user message, so the model",
	" * answers the image and the question in ONE response while the user message",
	" * itself stays untouched. */",
	"function dshOllamaInstallNoteHook(agent) {",
	"\tif (dshOllamaAgentHooks.has(agent)) return;",
	"\tdshOllamaAgentHooks.add(agent);",
	"\ttry {",
	"\t\tconst eventCtx = agent.ctx ?? agent;",
	"\t\teventCtx.on(\"agent/pre-step\", async (payload, next) => {",
	"\t\t\tconst stepAgent = (payload !== null && payload !== void 0 && typeof payload === \"object\" && payload.agent) || agent;",
	"\t\t\tconst decision = await next();",
	"\t\t\tconst pending = dshOllamaPendingNotes.get(stepAgent);",
	"\t\t\tif (pending === void 0) return decision;",
	"\t\t\tdshOllamaPendingNotes.delete(stepAgent);",
	"\t\t\tif (decision !== null && decision !== void 0 && decision.kind === \"enter\") {",
	"\t\t\t\treturn {",
	"\t\t\t\t\t...decision,",
	"\t\t\t\t\tmessages: [createUserMessage({ content: [{ type: \"text\", text: pending }], source: { kind: \"plugin\", plugin: \"dsh-ollama-vision-bridge\" } }), ...decision.messages]",
	"\t\t\t\t};",
	"\t\t\t}",
	"\t\t\treturn decision;",
	"\t\t});",
	"\t} catch {",
	"\t\t// hook registration failed; the description is skipped, request proceeds",
	"\t}",
	"}",
	"",
	"/** END dsh-ollama-vision-bridge helpers */"
];

/** The llm-pi-ai settings section appended to settings.yaml when absent. */
export const SETTINGS_SECTION = `
# --- dsh-ollama-vision-bridge: local Ollama provider (OpenAI-compatible endpoint) ---
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama 本地
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      models:
        - id: "qwen3-vl:8b"
          name: Qwen3-VL 8B
          input: [text, image]
          contextWindow: 32768
          maxTokens: 4096
`;

/** Default vision-bridge.yaml written when absent (user edits are preserved). */
export const BRIDGE_CONFIG_DEFAULT = `# dsh 视觉桥接配置（dsh-ollama-vision-bridge）：聊天模型不支持图片时，用本地 Ollama VL 模型描述图片
# 删除本文件或把 model 置空即关闭桥接，恢复 DSH 原生拒绝行为
baseURL: http://127.0.0.1:11434
model: "qwen3-vl:8b"
# 冷却机制：推理结束后 VL 模型在显存中驻留 keepAlive 时长（无新请求即自动卸载，腾出显存）
# 取值同 Ollama keep_alive："30s"/"5m"/秒数(60)/0（立即卸载）。默认 60s。
keepAlive: "60s"
`;
