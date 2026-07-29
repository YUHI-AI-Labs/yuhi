# Yuhi

<p align="center">
  <a href="https://www.npmjs.com/package/@yuhi-ai-labs/yuhi"><img alt="npm (beta)" src="https://img.shields.io/npm/v/@yuhi-ai-labs/yuhi/beta?label=npm%20%40beta&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/yuhi-ai-labs.yuhi-vscode?label=VS%20Code&color=007ACC&logo=visualstudiocode&logoColor=white"></a>
  <a href="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

**清楚地看到你的 AI 智能体究竟能看到什么。**

Yuhi 是一个本地优先的 **AI 上下文运行时(AI Context Runtime)**,面向 Claude Code、
Codex CLI、Gemini CLI 等编码智能体。它会扫描你的项目,应用一套简单的策略,然后在生成的、
经过过滤的仓库副本中启动智能体——**完全不修改你的原始文件**。

```bash
yuhi preview      # exactly what the agent would see
yuhi run claude   # launch Claude Code inside the generated context
```

Git 定义仓库状态。Docker 定义执行环境。**Yuhi 定义 AI 上下文**——交给智能体的、
最小、最安全、也最*有用*的项目视图。

> 🌐 也提供以下语言版本: [English](./README.md) · [日本語](./README.ja.md)

---

## 为什么需要 Yuhi

当你在工作目录中启动一个 AI 智能体时,它能读取那里的一切——`.env` 文件、云凭据、
客户数据、私有规格文档。Yuhi 让你能够**在智能体启动之前查看并塑造这份上下文**,
然后在一份干净的副本上运行智能体。

- **先预览。** `yuhi preview` 会显示智能体能看到和不能看到的每一个文件。
- **解释一切。** `yuhi explain path/to/file` 会告诉你哪条规则匹配了以及为什么。
- **绝不触碰你的仓库。** Yuhi 会复制到 `~/.yuhi/workspaces/<id>`;原始仓库对它是只读的。
- **将机密和私有数据排除在**上下文之外——或者在副本中对其进行脱敏。
- **同一套策略**在 CLI 和 VS Code 扩展中通用——处处使用同一套词汇。
- **无遥测**、无需账户、可离线工作。采用 Apache-2.0 许可证。

## 快速开始(约 2 分钟)

```bash
# In your project (Node.js 20+):
npx @yuhi-ai-labs/yuhi init        # writes yuhi.yaml (respects .gitignore etc.)
npx @yuhi-ai-labs/yuhi preview     # see what an agent would see
npx @yuhi-ai-labs/yuhi run dummy   # try the whole flow offline with a bundled stand-in agent
npx @yuhi-ai-labs/yuhi run claude  # launch Claude Code in the generated context
```

> npm 包名为 **`@yuhi-ai-labs/yuhi`**。当前版本为 **beta** dist-tag —
> 可用 `npx @yuhi-ai-labs/yuhi@beta preview` 明确指定 beta。若要从源码构建:
> `pnpm install && pnpm build`,然后执行 `node apps/cli/dist/index.js`。

`yuhi preview` 的输出示例:

```
Yuhi Preview

Agent: claude
Source: /Users/you/project

Sent to Claude  (9)
  ALLOW                README.md
  ALLOW                src/api.ts
  …

Prepared locally  (3)
  PREPARE              data/student_scores.csv
  REDACT               config/app.ts

Kept on your machine  (4)
  LOCAL-ONLY           customer-data/list.csv
  …

Excluded  (1)
  BLOCK                .env

Summary
  9 sent to claude        original files, unchanged
  3 prepared locally      transformed before sending
  4 kept on your machine  never sent to the AI
  ✓ 0 source files modified
```

## 策略: `yuhi.yaml`

这是一个小巧的声明式文件(由 `schemas/yuhi.schema.json` 校验——编辑器的自动补全开箱即用):

```yaml
version: "1"
defaults:
  action: allow
rules:
  - name: block-env
    match:
      paths: ["**/.env", "**/.env.*", "!**/.env.example"]
    action: block
  - name: redact-secrets
    match:
      detectors: [api-key, access-token, private-key]
    action: redact
  - name: keep-customer-data-local
    match:
      paths: ["customer-data/**"]
    action: local-only
```

动作: `allow`、`block`、`redact`、`local-only`、`ask`(以及计划中的
`metadata-only`、`summarize-local`)。当多条规则同时匹配时,**限制最严格的一条生效**;
并且任何被检测到的机密都会将该文件至少升级为 `redact`。

## 命令

| 命令 | 作用 |
|---|---|
| `yuhi init` | 创建 `yuhi.yaml`(遵循 `.gitignore`、`.dockerignore` 等) |
| `yuhi preview` | **标志性命令**——智能体将会看到什么 |
| `yuhi scan` | 本地检查: 机密与敏感文件(从不打印其值) |
| `yuhi explain <path>` | 为何某个文件被 allow / block / redact / local-only |
| `yuhi run <agent> [-- …]` | 生成上下文并启动智能体(`--` 用于转发参数) |
| `yuhi workspace list/inspect/clean` | 管理已生成的上下文 |
| `yuhi audit list/show/export` | 本地的、仅含元数据的运行历史 |
| `yuhi doctor` | 检查你的环境与配置 |

`--json`、`--quiet`、`--no-color` 以及 `--lang en|ja|zh-CN` 在所有命令中都受支持。

## ⚠️ Yuhi 是什么——以及不是什么

Yuhi 是**面向 AI 上下文的纵深防御(defense-in-depth),而不是沙箱。**它控制智能体的
*输入*起点。它**不会**:

- 拦截或阻断智能体的网络流量(智能体发送给其模型提供方的任何内容都不在 Yuhi 的控制范围内);
- 在操作系统层面封闭智能体的文件系统(一个有意为之的智能体进程仍然可以打开绝对路径或
  沿着 `..` 向上遍历);
- 保证零数据泄露。

我们刻意避免诸如“100% 安全”或“保证零泄露”之类的说法。完整的模型,以及通向可选沙箱后端
(Docker、`sandbox-exec`、bubblewrap、Windows Sandbox)的路线图,请参见
[`THREAT_MODEL.md`](./docs/THREAT_MODEL.md)。

## 功能状态

| 领域 | 状态 |
|---|---|
| `init` / `scan` / `preview` / `explain` | **Stable(稳定)** |
| 安全的工作区生成 + 脱敏 | **Stable(稳定)** |
| 策略引擎(glob、优先级、检测器) | **Stable(稳定)** |
| `dummy` 智能体(离线) + Claude Code 适配器 | **Stable(稳定)** |
| 本地审计日志 | **Stable(稳定)** |
| Codex / Gemini 适配器 | Planned(计划中) |
| VS Code 扩展(预览、Prepared Workspace 启动、徽章、状态) | **Beta**(已上架 VS Code Marketplace) |

### 在 VS Code 中启动 Prepared Workspace

`Yuhi: Prepare and Start Claude Code` 只准备并审查工作区一次，然后让官方
`anthropic.claude-code` 扩展或 `claude` CLI 仅以
`.yuhi/prepared/<runId>` 为工作根目录。生成的窗口会显示 **Prepared by Yuhi**、
估算的上下文缩减、敏感数据处理和逐文件决策。

这些数字是初始准备内容的估算，不保证实际模型输入、账单或成本节省。Yuhi
目前不提供操作系统级沙箱。
| 本地模型路由(`summarize-local`、`metadata-only`) | Planned(计划中・**v1.1**) |
| 操作系统沙箱后端 | Not implemented(未实现,设计见 `docs/THREAT_MODEL.md`) |

## 架构

一个 pnpm + TypeScript 的 monorepo。核心与 UI 无关(不依赖 VS Code):

```
packages/  shared · config · policy · scanner · processors · workspace · agents · audit · core
apps/      cli · vscode
```

参见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 以及 `docs/adr/`。

## 参与贡献

欢迎提交 Issue 和 PR——请参见 [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md) 和
[`CODE_OF_CONDUCT.md`](./docs/CODE_OF_CONDUCT.md)。新增一个智能体通常只需添加一条配置项;
新增一个机密检测器也是一处小而可测试的改动。

## 许可证

[Apache-2.0](./LICENSE) — © Yuhi contributors。无遥测。本地优先。厂商中立。
