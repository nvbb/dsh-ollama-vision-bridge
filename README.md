# dsh-ollama-vision-bridge

DeepSeek Harness（DSH）插件（适配 **DSH ≥ 0.1.2-rc.1**）：**当聊天选中的模型不支持图片时，
自动用本地 Ollama VL 模型描述图片**，并把说明在**同一个模型步骤**里注入给模型；图片本身
保留在对话历史里（请求携带 Ollama `keep_alive`，推理结束后模型在显存中只驻留一小段时间，
空闲即自动卸载——显存冷却，不占其他模型的显存）。

## 原理

- 安装时（`patch/apply.mjs`）给 `@deepseek-ai/dsh-api-session-controller` 打一个幂等补丁。
  DSH 0.1.2-rc.1 删除了旧版 `dsh-host-apiproxy`，把「聊天发图 → 模态检查 → 入队」挪进了
  这个包（Web GUI 运行的是其 bundle `lib/index.js`，另有同类的独立编译产物
  `lib/types/commands.js`，两处都打）。原逻辑是「模型不支持图片 → 抛
  `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝」，补丁把它改为先调本地 Ollama VL 模型（默认
  `qwen3-vl:8b`）：
  - 图片先按 DSH 原生流程**落库成 durable 引用并保留在你的消息里**，你的消息一字不改，
    且只排队这一条消息（一次发送 = 一次回答，不会多出额外回复）；
  - 描述通过 **`agent/pre-step` 瀑布钩子**在模型请求生成时并入**同一步骤**；
  - 描述作为独立的**「上下文注入」消息**（`source: { kind: "plugin", plugin: "dsh-ollama-vision-bridge" }`）
    进入对话，界面显示为一条可折叠的"上下文注入"条目；
  - 描述文本自带**系统说明**，引导模型在回答开头告知「当前模型不支持原生图片识别，
    已调用本地视觉模型识别」，然后基于描述正式回答；
  - 桥接未配置或 Ollama 不可用时回退到 DSH 原有的拒绝行为（错误码不变）。
- 备注：0.1.2-rc.1 自带的 `dsh-llm` 已会把「文本模型请求中的图片块」投影成
  `[image omitted …]` 占位文本，所以保留图片引用的用户消息永远不会真正发给文本适配器；
  桥接的价值在于让模型拿到**本地 VL 模型对图片的真实描述**，而不是一个空占位符。
- 运行时（`lib/index.js`）是一个极小且不会抛错的 Cordis 行，启动时检查补丁/配置状态并
  打印日志，也提供 `/vision-bridge` 状态命令（若 commands 服务存在）。
- 包声明了 `dsh.bundle.patch`，`dsh plugin add` 后会自动挂进 profile 的 bundles 层
  （补丁行 `vision-bridge`），无需手改 cordis.patch.yml。

## 安装（首次 / 换新机器）

> 先停掉正在运行的 `dsh web`（Windows 上 node 会锁住 node_modules，运行中装不了）。

方式一：从你的 git 仓库安装（推荐，见下文「放到自己的 git 仓库」）：

```powershell
dsh plugin --profile web add git+https://github.com/<你的账号>/dsh-ollama-vision-bridge.git
node "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-ollama-vision-bridge\patch\apply.mjs"
```

方式二：本地路径安装（不需要 git 远程，机器本地即可）：

```powershell
dsh plugin --profile web add file:D:/CLAW-SHARE/DSH/dsh-ollama-vision-bridge
node "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-ollama-vision-bridge\patch\apply.mjs"
```

然后重新启动 `dsh web`。

`apply.mjs` 做四件事（幂等，可重复跑）：
1. 补丁 `dsh-api-session-controller` 的两份产物（已打则跳过）；
2. `settings.yaml` 追加 `llm-pi-ai` 提供商 `ollama`（已有该段则跳过）；
3. `settings.yaml` 的 `vision-bridge` 段 / 独立 `vision-bridge.yaml`（已有则跳过）；
4. 检查 `OLLAMA_MODELS` 下有没有 VL 模型 manifest，没有就给出提示。

## DSH 更新后

`dsh plugin` 或 pnpm 重装会覆盖被打补丁的包，重跑一次即可：

```powershell
dsh plugin --profile web update dsh-ollama-vision-bridge   # 或直接 dsh plugin --profile web add <同上>
node "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-ollama-vision-bridge\patch\apply.mjs"
```

## 配置

配置在 **DSH 的设置文档** `$DSH_HOME\settings.yaml` 的 `vision-bridge:` 段
（与 `llm-pi-ai` 同款，**热加载**，改完即生效，不用重启；旧的独立
`vision-bridge.yaml` 仍作为兼容回退，优先读 settings.yaml）：

```yaml
vision-bridge:
  enabled: true                     # 总开关；false 时文本模型发图恢复 DSH 原生拒绝
  baseURL: http://127.0.0.1:11434   # Ollama 地址
  model: "qwen3-vl:8b"              # 默认兜底 VL 模型
  keepAlive: "60s"                  # 显存冷却：空闲 60s 后卸载；0 = 推理完立即卸载
  # models:                         # 按模型映射（可选，覆盖默认）：选中这些文本模型发图时用对应 VL 模型
  #   "deepseek-v4-flash": "qwen3-vl:8b"
  # prompt: 自定义描述提示词（可选）
  # timeoutMs: 300000
```

环境变量可覆盖：`DSH_VISION_BRIDGE_BASE_URL` / `DSH_VISION_BRIDGE_MODEL` /
`DSH_VISION_BRIDGE_KEEP_ALIVE`。删除 `vision-bridge` 段（或置空 `model`、或
`enabled: false`）即关闭桥接，恢复 DSH 原生拒绝行为。

前提：Ollama 在跑（`ollama list` 能看到模型），模型目录环境变量
`OLLAMA_MODELS` 指向含 `qwen3-vl:8b` 的目录。

## 放到你自己的 git 仓库

```powershell
cd D:\CLAW-SHARE\DSH\dsh-ollama-vision-bridge
git init
git add .
git commit -m "dsh ollama vision bridge plugin"
# 在 GitHub / Gitee 建一个空仓库后：
git remote add origin https://github.com/<你的账号>/dsh-ollama-vision-bridge.git   # 或 gitee
git push -u origin main
```

之后任何机器（主机崩了重装、换电脑）都只需要：
```powershell
dsh plugin --profile web add git+https://github.com/<你的账号>/dsh-ollama-vision-bridge.git
node "...\dsh-ollama-vision-bridge\patch\apply.mjs"
```

私有仓库需要先配好 git 凭据（Windows 凭据管理器 / SSH）。

## 目录结构

```
dsh-ollama-vision-bridge/
├── package.json          # dsh.bundle.patch → 自动挂载为 profile bundle
├── cordis.patch.yml      # 插入 vision-bridge 运行时行
├── lib/index.js          # 运行时状态检查（绝不抛错）
└── patch/
    ├── source.mjs        # 补丁源码（单一事实源，含 v2 辅助代码与锚点）
    └── apply.mjs         # 安装/重装/检查脚本（支持 --check / --file）
```

## 已知限制

- 依赖 `dsh-api-session-controller` 的 `prompt` 处理器两个稳定锚点（`lib/index.js` 的
  单行拒绝式与 `lib/types/commands.js` 的多行拒绝块）。DSH 大版本若改动它们，
  `apply.mjs` 会报「refusal anchor not found」，届时更新本插件即可。
- 仅覆盖 Web GUI 普通会话的聊天发图路径；子代理等平行入口的图片拒绝（`subagent/attachment-invalid`）
  不在桥接范围内（与旧版一致）。
- 直接选中 VL 模型（如 `qwen3-vl:8b`）发图走 DSH 原生通道，不经过桥接，其卸载时机由
  Ollama 全局 `OLLAMA_KEEP_ALIVE`（默认 5 分钟）决定。
