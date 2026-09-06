/**
 * bridge-smoke.mjs — standalone smoke test for the v2 bridge helpers.
 *
 * Re-instantiates the appended module-scope helper code (patch/source.mjs
 * HELPERS_LINES) inside a module with stubbed DSH dependencies, then drives a
 * real admission (bridge config via the documented env override below) and a
 * REAL local Ollama inference:
 *
 *   1. dshOllamaAdmit() reads the bridge config, admits the content (stub),
 *      reads the image back (stub bytes) and asks the local Ollama VL model
 *      to describe it (real HTTP + real inference).
 *   2. On success it must return true, have enqueued the user message on the
 *      agent (followup) and installed an agent/pre-step listener.
 *   3. Firing that listener with an "enter" decision must return a decision
 *      whose messages start with the plugin "上下文注入" note.
 *
 * Exit code 0 = all assertions passed. Requires Ollama running on
 * 127.0.0.1:11434 with the configured VL model present.
 *
 * Why the env override below: the injected helpers resolve the bridge config
 * from settings.yaml via a dynamic `js-yaml` import. This test re-instantiates
 * the helper code inside a `data:` URL module, where bare specifiers cannot
 * resolve (ERR_UNSUPPORTED_RESOLVE_REQUEST), so the settings.yaml branch would
 * always fail silently and the test could never pass. Pointing the bridge at
 * the documented env override takes the same code path as the settings.yaml
 * config (baseURL/model/keepAlive fields) without the settings read.
 */

process.env.DSH_VISION_BRIDGE_MODEL ??= "qwen3-vl:8b";

import { HELPERS_LINES } from "../patch/source.mjs";

// ---- stubs -------------------------------------------------------------

// 1x1 transparent-ish PNG
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const createUserMessage = (input) => ({
	id: `msg-${Math.random().toString(36).slice(2)}`,
	role: "user",
	...input
});

const admitPromptContent = async (_attachments, content) =>
	content.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", attachment: { attachmentId: "sha256:test", mediaType: part.mediaType, bytes: 68, width: 1, height: 1 } }
	);

const controller = {
	ctx: {
		attachments: {
			async readImage(ref) {
				return {
					ref: { attachmentId: ref.attachmentId, mediaType: ref.mediaType },
					data: Buffer.from(PNG_B64, "base64")
				};
			}
		}
	}
};

const agent = {
	id: "smoke-agent",
	called: null,
	hook: null,
	steer() {
		this.called = "steer";
	},
	followup() {
		this.called = "followup";
	},
	ctx: {
		on(name, fn) {
			this.hook = { name, fn };
		}
	}
};

// ---- instantiate the real helper code ----------------------------------

const prelude = `
const createUserMessage = ${createUserMessage.toString()};
const admitPromptContent = ${admitPromptContent.toString()};
`;

const code = `${prelude}\n${HELPERS_LINES.join("\n")}\n\nexport { dshOllamaAdmit, dshOllamaBridgeConfig, dshOllamaDescribe };\n`;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`);

// ---- run ----------------------------------------------------------------

const content = [
	{ type: "text", text: "请告诉我这张图里画了什么" },
	{ type: "image", mediaType: "image/png", data: PNG_B64, name: "t.png" }
];

const source = { kind: "user", rpcId: "smoke-r1" };
const started = Date.now();
const result = await mod.dshOllamaAdmit(controller, agent, "deepseek-v4-flash", content, source, "followup");
const tookMs = Date.now() - started;
console.log(`dshOllamaAdmit -> ${result} (${tookMs} ms, incl. Ollama inference)`);

if (result !== true) {
	console.error("FAIL: bridge returned null (config off, Ollama down, or description failed)");
	process.exit(1);
}
if (agent.called !== "followup") {
	console.error(`FAIL: expected followup enqueue, got ${agent.called}`);
	process.exit(1);
}
if (agent.ctx.hook === null || agent.ctx.hook.name !== "agent/pre-step") {
	console.error("FAIL: agent/pre-step hook not installed");
	process.exit(1);
}

// ---- fire the pre-step listener like the agent loop does ---------------
const claimed = [createUserMessage({ content, source })];
const decision = await agent.ctx.hook.fn(
	{ agent, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
	async () => ({ kind: "enter", messages: [...claimed] })
);
if (decision.kind !== "enter") {
	console.error("FAIL: pre-step decision not enter");
	process.exit(1);
}
const first = decision.messages[0];
const text = Array.isArray(first.content) ? first.content.map((b) => b.text ?? "").join("") : "";
if (!(first.source?.kind === "plugin" && first.source?.plugin === "dsh-ollama-vision-bridge")) {
	console.error("FAIL: note message source is not plugin/dsh-ollama-vision-bridge");
	process.exit(1);
}
if (!text.includes("图片说明") || text.length < 20) {
	console.error("FAIL: note text missing/empty (description too short or blank)");
	process.exit(1);
}
console.log("note message OK: source=plugin, first 60 chars =", JSON.stringify(text.slice(0, 60)));
console.log("SMOKE TEST PASSED");
