/**
 * dsh-ollama-vision-bridge — patch source of truth.
 *
 * The exact JS inserted into @deepseek-ai/dsh-host-apiproxy/lib/index.js, kept
 * here as arrays of lines so patch/apply.mjs can insert them byte-exact and
 * so the re-apply logic stays version-agnostic (it locates stable anchors in
 * the target file rather than patching by line numbers).
 *
 * If a future dsh release renames/removes the anchors, apply.mjs reports a
 * clear "anchors not found" error — bump this package then.
 */

export const MARKER = "VISION BRIDGE PATCH";

/** Anchor: insert helpers immediately before this function definition. */
export const ANCHOR_DURABLE_PROMPT = "async function durablePromptContent(ctx, content)";

/** Anchor (regex): the single-line image-modality refusal in the prompt RPC. */
export const ANCHOR_REFUSAL = /if \(modelInfo\.inputModalities !== void 0 && !modelInfo\.inputModalities\.includes\("image"\)\) return err\(request/;

/**
 * Helper functions inserted before durablePromptContent. Reads
 * $DSH_HOME/vision-bridge.yaml (or env DSH_VISION_BRIDGE_BASE_URL /
 * DSH_VISION_BRIDGE_MODEL / DSH_VISION_BRIDGE_KEEP_ALIVE), describes each
 * image through the local Ollama VL model, keeps the image blocks in history
 * and appends a text block with the description. Returns null when the bridge
 * is unavailable so callers keep the original refusal behavior.
 */
export const HELPER_LINES = [
'/** VISION BRIDGE PATCH (dsh-ollama-vision-bridge): describe attached images with a local',
' * Ollama VL model when the selected chat model is text-only. Reads',
' * $DSH_HOME/vision-bridge.yaml (or env DSH_VISION_BRIDGE_BASE_URL /',
' * DSH_VISION_BRIDGE_MODEL / DSH_VISION_BRIDGE_KEEP_ALIVE). Returns null when',
' * the bridge is unavailable, in which case callers keep the original',
' * refusal behavior. */',
'async function visionBridgeConfig() {',
'	const envBase = process.env.DSH_VISION_BRIDGE_BASE_URL;',
'	const envModel = process.env.DSH_VISION_BRIDGE_MODEL;',
'	const envKeep = process.env.DSH_VISION_BRIDGE_KEEP_ALIVE;',
'	if (envBase !== void 0 || envModel !== void 0) {',
'		if (typeof envModel !== "string" || envModel === "") return null;',
'		return { baseURL: typeof envBase === "string" && envBase !== "" ? envBase : "http://127.0.0.1:11434", model: envModel, keepAlive: typeof envKeep === "string" && envKeep !== "" ? envKeep : "60s" };',
'	}',
'	try {',
'		const { readFile } = await import("node:fs/promises");',
'		const { join } = await import("node:path");',
'		const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");',
'		const text = await readFile(join(home, "vision-bridge.yaml"), "utf8");',
'		const yaml = await import("js-yaml");',
'		const doc = yaml.load(text);',
'		if (doc !== null && typeof doc === "object" && typeof doc.model === "string" && doc.model !== "") {',
'			return {',
'				baseURL: typeof doc.baseURL === "string" && doc.baseURL !== "" ? doc.baseURL : "http://127.0.0.1:11434",',
'				model: doc.model,',
'				keepAlive: typeof doc.keepAlive === "string" ? doc.keepAlive : typeof doc.keepAlive === "number" ? doc.keepAlive : "60s",',
'				prompt: typeof doc.prompt === "string" ? doc.prompt : void 0,',
'				timeoutMs: Number.isFinite(doc.timeoutMs) ? doc.timeoutMs : 300000',
'			};',
'		}',
'	} catch {',
'		// bridge config unreadable or absent; bridge stays off',
'	}',
'	return null;',
'}',
'/** Ask the local Ollama VL model to describe one data-URI image. */',
'async function ollamaVisionDescribe(cfg, dataUri) {',
'	const base = String(cfg.baseURL).replace(/\\/v1\\/?$/, "");',
'	const prompt = cfg.prompt ?? "\u8bf7\u7528\u4e2d\u6587\u7b80\u8981\u3001\u51c6\u786e\u5730\u63cf\u8ff0\u8fd9\u5f20\u56fe\u7247\u7684\u5185\u5bb9\uff0c\u5305\u62ec\u4e3b\u8981\u5143\u7d20\u3001\u6587\u5b57\u3001\u5e03\u5c40\u4e0e\u5173\u7cfb\u3002\u63a7\u5236\u5728200\u5b57\u4ee5\u5185\u3002";',
'	const payload = {',
'		model: cfg.model,',
'		messages: [{ role: "user", content: [',
'			{ type: "text", text: prompt },',
'			{ type: "image_url", image_url: { url: dataUri } }',
'		] }],',
'		stream: false,',
'		keep_alive: cfg.keepAlive ?? "60s",',
'		temperature: 0.2,',
'		max_tokens: 512',
'	};',
'	try {',
'		const resp = await fetch(`${base}/v1/chat/completions`, {',
'			method: "POST",',
'			headers: { "Content-Type": "application/json" },',
'			body: JSON.stringify(payload),',
'			signal: AbortSignal.timeout(cfg.timeoutMs ?? 300000)',
'		});',
'		if (!resp.ok) return null;',
'		const body = await resp.json();',
'		const text = body?.choices?.[0]?.message?.content;',
'		return typeof text === "string" && text.trim() !== "" ? text.trim() : null;',
'	} catch {',
'		return null;',
'	}',
'}',
'/** Store prompt images and describe each through the local Ollama VL model.',
' * Returns { durable, note, model }: `durable` keeps the image blocks for',
' * history and is used for the user\'s own message untouched; `note` is the',
' * joined description text (null when there is nothing to note). Returns null',
' * when the bridge cannot serve, so callers keep the original refusal',
' * behavior. The description is NEVER merged into the user message. */',
'async function visionBridge(ctx, content) {',
'	const cfg = await visionBridgeConfig();',
'	if (cfg === null) return null;',
'	const durable = await durablePromptContent(ctx, content);',
'	const imageBlocks = durable.filter((block) => block.type === "image");',
'	if (imageBlocks.length === 0) return { durable, note: null, model: cfg.model };',
'	const notes = [];',
'	for (const block of imageBlocks) {',
'		const stored = await ctx.attachments.readImage(block.attachment);',
'		const dataUri = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;',
'		const desc = await ollamaVisionDescribe(cfg, dataUri);',
'		if (desc === null) return null;',
'		notes.push(desc);',
'	}',
'	return { durable, note: notes.join("\\n\\n"), model: cfg.model };',
'}',
'/** Per-agent pending vision note, keyed by the agent object (WeakMap). */',
'const pendingVisionNotes = new WeakMap();',
'/** Install (once per agent) an "agent/pre-step" waterfall listener that appends',
' * the pending vision note to the SAME step as the user message, so the model',
' * answers the image and the question in ONE response while the user message',
' * itself stays untouched. */',
'function installVisionNoteHook(agent) {',
'	if (agent.visionBridgeHook === true) return;',
'	agent.visionBridgeHook = true;',
'	try {',
'		agent.ctx.on("agent/pre-step", async (payload, next) => {',
'			const pending = pendingVisionNotes.get(agent);',
'			if (pending === void 0) return next(payload);',
'			const decision = await next(payload);',
'			if (decision !== null && decision !== void 0 && decision.kind === "enter") {',
'				decision.messages = [createUserMessage({',
'					content: [{ type: "text", text: pending }],',
'					source: { kind: "plugin", plugin: "dsh-ollama-vision-bridge" }',
'				}), ...(decision.messages ?? [])];',
'			}',
'			pendingVisionNotes.delete(agent);',
'			return decision;',
'		});',
'	} catch {',
'		// hook registration failed; the description is skipped, request proceeds',
'	}',
'}',
''
];

/** Replacement for the refusal statement (5 lines -> 20 lines, tab indented).
 * The user's own message keeps the image blocks and their text untouched and
 * is queued alone; the VL description is staged in `pendingVisionNotes` and
 * appended by the pre-step hook to the SAME step as the user message, so one
 * send produces exactly one assistant response (with the description in
 * context) and the transcript shows a single 上下文注入 row. */
export const REFUSAL_REPLACEMENT_LINES = [
'\t\t\t\t\t\t\tif (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {',
'\t\t\t\t\t\t\t\tconst bridged = await visionBridge(ctx, content);',
'\t\t\t\t\t\t\t\tif (bridged !== null) {',
'\t\t\t\t\t\t\t\t\tif (bridged.note !== null) {',
'\t\t\t\t\t\t\t\t\t\tinstallVisionNoteHook(agent);',
'\t\t\t\t\t\t\t\t\t\tpendingVisionNotes.set(agent, `[\u56fe\u7247\u8bf4\u660e\uff08\u672c\u5730\u89c6\u89c9\u6a21\u578b ${bridged.model} \u751f\u6210\uff09]\\n${bridged.note}\\n\\n\uff08\u7cfb\u7edf\u8bf4\u660e\uff1a\u7528\u6237\u9644\u52a0\u4e86\u56fe\u7247\u3002\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u539f\u751f\u56fe\u7247\u8bc6\u522b\uff0c\u4ee5\u4e0a\u63cf\u8ff0\u7531\u672c\u5730\u89c6\u89c9\u6a21\u578b ${bridged.model} \u751f\u6210\u3002\u8bf7\u5728\u56de\u7b54\u5f00\u5934\u7b80\u8981\u8bf4\u660e\u8fd9\u4e00\u70b9\uff0c\u7136\u540e\u57fa\u4e8e\u56fe\u7247\u5185\u5bb9\u56de\u7b54\u7528\u6237\u7684\u95ee\u9898\u3002\uff09`);',
'\t\t\t\t\t\t\t\t}',
'\t\t\t\t\t\t\t\tconst message = createUserMessage({ content: bridged.durable, source });',
'\t\t\t\t\t\t\t\tif (mode === "steer") agent.steer(message);',
'\t\t\t\t\t\t\t\telse agent.followup(message);',
'\t\t\t\t\t\t\t\treturn ok(request, { accepted: true });',
'\t\t\t\t\t\t\t}',
'\t\t\t\t\t\t\treturn err(request, {',
'\t\t\t\t\t\t\t\tcode: "attachment-error",',
'\t\t\t\t\t\t\t\tmessage: `Model "${current.model}" does not support image input.`,',
'\t\t\t\t\t\t\t\tdetails: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }',
'\t\t\t\t\t\t\t});',
'\t\t\t\t\t\t}'
];

/** The llm-pi-ai settings section appended to settings.yaml (if absent). */
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
