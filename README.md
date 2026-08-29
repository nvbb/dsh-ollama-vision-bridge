# dsh-ollama-vision-bridge

DeepSeek Harness（DSH）插件：**当聊天选中的模型不支持图片时，自动用本地 Ollama
VL 模型描述图片**，并把说明追加进消息文本；图片本身保留在对话历史里。请求携带
Ollama `keep_alive`，推理结束后模型在显存中只驻留一小段时间，空闲即自动卸载
（显存冷却，不占其他模型的显存）。

## 原理

- 安装时（`patch/apply.mjs`）给 `@deepseek-ai/dsh-host-apiproxy` 打一个幂等补丁：
  `sessions.prompt` 里原本「模型不支持图片 → 拒绝」的分支，改为先调本地
  Ollama VL 模型（默认 `qwen3-vl:8b`）生成图片描述，再发送消息：
  - **你的消息保持原样**（图片 + 你的文字，一个字都不改）；
  - VL 描述作为**独立的「上下文注入」消息**（`source: { kind: "plugin" }`）送进对话，
    界面显示为可折叠的“上下文注入”条目，模型能读到、你的气泡不被污染；
  - 桥接未配置或 Ollama 不可用时回退到 DSH 原有的拒绝行为。
- 运行时（`lib/index.js`）是一个极小且不会抛错的 Cordis 行，启动时检查补丁/配置
  状态并打印日志，也提供 `/vision-bridge` 状态命令（若 commands 服务存在）。
- 包声明了 `dsh.bundle.patch`，`dsh plugin add` 后会自动挂进 profile 的
  bundles 层（补丁行 `vision-bridge`），无需手改 cordis.patch.yml。

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
1. 补丁 `dsh-host-apiproxy`（已打则跳过）；
2. `settings.yaml` 追加 `llm-pi-ai` 提供商 `ollama`（已有该段则跳过）；
3. 生成 `vision-bridge.yaml`（已存在则保留你的修改）；
4. 检查 `OLLAMA_MODELS` 下有没有 VL 模型 manifest，没有就给出提示。

## DSH 更新后

`dsh plugin` 或 pnpm 重装会覆盖被打补丁的包，重跑一次即可：

```powershell
dsh plugin --profile web update dsh-ollama-vision-bridge   # 或直接 dsh plugin --profile web add <同上>
node "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-ollama-vision-bridge\patch\apply.mjs"
```

## 配置

`$DSH_HOME\vision-bridge.yaml`（默认 `C:\Users\Administrator\.dsh\vision-bridge.yaml`）：

```yaml
baseURL: http://127.0.0.1:11434
model: "qwen3-vl:8b"
keepAlive: "60s"   # 显存冷却：空闲 60s 后 VL 模型自动卸载；0 = 推理完立即卸载
# prompt: 自定义描述提示词（可选）
```

环境变量可覆盖：`DSH_VISION_BRIDGE_BASE_URL` / `DSH_VISION_BRIDGE_MODEL` /
`DSH_VISION_BRIDGE_KEEP_ALIVE`。删除 `vision-bridge.yaml`（或置空 `model`）即
关闭桥接，恢复 DSH 原生拒绝行为。

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
    ├── source.mjs        # 补丁源码（单一事实源）
    └── apply.mjs         # 安装/重装/检查脚本
```

## 已知限制

- 依赖 `dsh-host-apiproxy` 内部两个稳定锚点；DSH 大版本若改动它们，`apply.mjs`
  会报「anchors not found」，届时更新本插件即可。
- 直接选中 VL 模型（如 `qwen3-vl:8b`）发图走 DSH 原生通道，不经过桥接，
  其卸载时机由 Ollama 全局 `OLLAMA_KEEP_ALIVE`（默认 5 分钟）决定。
