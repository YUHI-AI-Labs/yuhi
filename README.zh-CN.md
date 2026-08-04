<h1 align="center">Yuhi</h1>

<p align="center"><strong>让任何仓库都成为 AI-ready 的仓库。</strong></p>

<p align="center">在编码智能体看到你的仓库之前，Yuhi 会先准备一个更小、更干净、更安全的工作区——你可以在本地详细查看 AI 能看到什么，而可分享的只是 public-safe 的汇总摘要。</p>

> **当前版本：0.3.6** — **Safe Patch Review：先审查，再安全应用。** Claude Code / Codex 的更改保留在 Prepared Repository 中；只有用户明确选择并通过重新验证的文件或文本片段才会应用到 Source Repository。Yuhi 不会自动应用更改。

<p align="center">
  <a href="https://www.npmjs.com/package/@yuhi-ai-labs/yuhi"><img alt="npm (beta)" src="https://img.shields.io/npm/v/@yuhi-ai-labs/yuhi/beta?label=npm%20%40beta&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/yuhi-ai-labs.yuhi-vscode?label=VS%20Code&color=007ACC&logo=visualstudiocode&logoColor=white"></a>
  <a href="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

<p align="center">🌐 也提供以下语言版本: <a href="./README.md">English</a> · <a href="./README.ja.md">日本語</a></p>

---

## 一条命令

```bash
npx @yuhi-ai-labs/yuhi prepare
```

Yuhi 会在本地检查你的仓库，准备一份经过缩减和脱敏的副本，并打印出一份
**仓库报告(Repository Report)**——具体、可衡量、可分享的结果:

```text
Repository Ready

  Source files             5,224
  Prepared artifacts         317
  Documents prepared          42
  Secrets blocked             18
  Identifiers transformed    103

  Estimated accessible-content reduction: 94%

Ready for Claude Code.
```

> 这些是 **已准备的初始内容的估算值**——即仓库中有多少被开放给智能体访问——
> 而 **不是** 对模型 token 用量或成本的测量。你的原始文件永远不会被修改。

## 原生 Claude GUI (v0.4.1)

**在官方 Claude Code GUI 中，直接使用 Yuhi Dynamic Context。**

运行 **Yuhi: Open Claude Code Dynamic Workspace**，官方 Anthropic Claude Code 扩展会在隔离的
VS Code 环境中启动，该会话通过 Yuhi Dynamic Context。Yuhi 不会用自定义聊天 UI 取代 Claude Code。

- 与常规 VS Code 环境隔离（独立的 `user-data-dir` 与 `extensions-dir`）
- 不改动你的常规配置
- Developer Mode / Strict Mode，与 CLI 同一套策略
- 动态压缩较大的工具输出，被省略的部分仍可按需检索
- 窗口关闭时自动清理网关、MCP 注册、session lock 与其管理的设置

**Yuhi 不会读取、复制或存储你的 Claude 凭据。** 支持已有的 Claude Code 认证；
**在隔离环境中的首次登录尚未验证。**

**已知限制**：已在 macOS 验证；Linux 与 Windows 已实现并测试但尚未在真实 GUI 验证；
Remote SSH、WSL、Dev Containers 与 Codespaces 均 fail closed；Strict Mode 覆盖取决于文件格式与内容；
Dynamic reduction 不等于 provider token 总量或成本的降幅；绝对 token 数使用回退启发式。

详见: [docs/design/V0_4_1_NATIVE_GUI.md](docs/design/V0_4_1_NATIVE_GUI.md) ·
[docs/V0_4_1_RELEASE_SCOPE.md](docs/V0_4_1_RELEASE_SCOPE.md)

## 看看你的仓库里，AI 究竟需要多少

编码智能体从你的工作目录内部启动，能读取那里的一切——`.env` 文件、云凭据、
客户数据、庞大的构建产物、二进制块。其中大部分并不是智能体需要的上下文，
有一些则是它根本不该拥有的上下文。

Yuhi 回答一个简单的问题——*这个仓库里，AI 真正应该看到多少?*——
然后正好准备这么多:

- **拦截机密。** 凭据和私钥会在本地被无害化，绝不会交给智能体。
- **将文档转换为对 AI 友好的内容。** 受支持的文档（PDF / DOCX / PPTX）会变成经过净化的 Markdown 副本；当无法验证安全准备时，源文件会保留在本地或替换为安全占位符，原始文件绝不会交给智能体。
- **将仓库缩减到真正重要的部分。** 过大的、二进制的、无关的文件都留在本地，不予发送。
- **一条命令即准备好 Claude Code。** 把智能体指向 Prepared Workspace，即可开始。

## 分享结果

报告才是重点。每一种格式都 **可安全公开**——只有聚合数字，绝不包含
文件名、路径、机密类型或身份信息——因此可以放心地贴进 README、PR 或帖子:

```bash
yuhi report <run> --format markdown   # a table for your README or PR
yuhi report <run> --format json       # machine-readable, for CI
yuhi report <run> --format svg        # a "Prepared with Yuhi — 94% reduced" badge
```

把徽章放进你的 README:

```bash
yuhi report <run> --format svg > .github/yuhi-badge.svg
```

```md
![Prepared with Yuhi](.github/yuhi-badge.svg)
```

或者让 CI 自动发布它——[Yuhi report GitHub Action](./actions/yuhi-report)
会把一份 **仓库报告** 写入每次运行的 Job Summary(仅报告;不设 PR 门禁，也无写入权限)。

## 打开 Claude Code

**在 VS Code 中**——安装
[Yuhi 扩展](https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode)
并运行 **`Yuhi: Prepare and Start Claude Code`**。Yuhi 会准备并审查工作区，
然后在一个标记为 **Prepared by Yuhi** 的新窗口中打开 Prepared Workspace，
供官方的 `anthropic.claude-code` 扩展使用。

**在命令行中**——`yuhi prepare` 与 `yuhi report` 现已可用。智能体的启动目前通过 VS Code 扩展提供。

> Yuhi 准备的是 *初始上下文*。它 **不是** 操作系统级的沙箱:如果智能体的运行时或你本人
> 允许，智能体仍可能访问 Prepared Workspace 之外的路径。参见
> [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md)。

## 工作原理

```text
Scan   →  inspect the repository locally for secrets, PII, documents, and noise
Prepare→  neutralize secrets, de-identify tables, convert documents, drop what isn't needed
Verify →  rescan the delivered artifacts before anything is handed off (fail-closed)
Report →  a public-safe Repository Report — terminal / Markdown / JSON / SVG
```

一切都在 **你自己的机器上** 运行。无遥测、无需账户、可离线工作。你的原始文件对 Yuhi
是只读的;准备好的副本存放在一个受管理的工作区目录下。

## Yuhi 是什么——以及不是什么

Yuhi 是 **面向 AI 上下文的纵深防御(defense-in-depth),而不是沙箱。** 它控制智能体
起步时的 *输入*。它 **不会**:

- 拦截或阻断智能体的网络流量(智能体发送给其模型提供方的任何内容都不在 Yuhi 的控制范围内);
- 在操作系统层面封闭智能体的文件系统(一个有意为之的智能体进程仍然可以打开绝对路径或沿着 `..` 向上遍历);
- 保证零数据泄露。

我们刻意避免诸如“100% 安全”或“保证零泄露”之类的说法。完整的模型，以及通向可选沙箱后端
(Docker、`sandbox-exec`、bubblewrap、Windows Sandbox)的路线图，请参见
[`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `yuhi prepare [dir]` | **标志性命令**——准备一份缩减、脱敏的副本，并打印仓库报告 |
| `yuhi report <run> [--format …]` | 打印可分享、可安全公开的仓库报告(terminal / markdown / json / svg) |
| `yuhi init` | 创建 `yuhi.yaml`(遵循 `.gitignore`、`.dockerignore` 等) |
| `yuhi scan` | 本地检查: 机密与敏感文件(从不打印其值) |
| `yuhi status` | 一眼看清 AI 上下文——就像 `git status` |
| `yuhi preview` | 精确显示智能体将会看到什么 |
| `yuhi explain <path>` | 某个文件为何被准备、拦截、脱敏或留在本地 |
| `yuhi doctor` | 检查你的环境与配置 |

`--json`、`--quiet`、`--no-color` 以及 `--lang en|ja|zh-CN` 在所有命令中都受支持。
进阶: `yuhi workspace list/inspect/clean`、`yuhi review <run>`、`yuhi audit list/show/export`。

> npm 包名为 **`@yuhi-ai-labs/yuhi`**(当前版本为 **beta** dist-tag——可用
> `@yuhi-ai-labs/yuhi@beta` 固定版本)。若要从源码构建: `pnpm install && pnpm build`，然后执行
> `node apps/cli/dist/index.js`。

## 策略: `yuhi.yaml`

这是一个小巧的声明式文件(由 `schemas/yuhi.schema.json` 校验——编辑器的自动补全开箱即用)。
`yuhi init` 写出的文件已带有合理的默认值,你很少需要去编辑它:

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

当多条规则同时匹配时，**限制最严格的一条生效**;并且任何被检测到的机密都会将该文件
至少升级为 `redact`。

## 架构

一个 pnpm + TypeScript 的 monorepo。核心与 UI 无关(不依赖 VS Code):

```
packages/  shared · config · policy · scanner · processors · workspace · agents · audit · core
apps/      cli · vscode
```

参见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 以及 `docs/adr/`。

## 项目方向

- [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — Yuhi 防护什么，以及 **不** 防护什么。
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 代码库如何组织。

## 参与贡献

欢迎提交 Issue 和 PR——请参见 [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md) 和
[`CODE_OF_CONDUCT.md`](./docs/CODE_OF_CONDUCT.md)。新增一个智能体通常只需添加一条配置项;
新增一个机密检测器也是一处小而可测试的改动。

## 许可证

[Apache-2.0](./LICENSE) — © Yuhi contributors。无遥测。本地优先。厂商中立。


## 动态上下文 (v0.4.0)

`yuhi launch claude --dynamic-context`（或 VS Code 中的 **Yuhi: Start Claude Code with Dynamic Context**）让 Claude Code 通过本地网关运行：每个新的 tool result 都会先被私有存储、扫描、压缩并二次扫描，然后才发送给提供方；被省略的部分始终可以取回。

实测（真实 Claude Code、haiku、n=3、提供方报告值）：补丁正确 3/3，输入侧 token −22%，提供方费用 −13%，投递的 tool output −70%。*结果因任务、模型、缓存行为与 retrieval 配置而异。*

### Developer Mode

动态运行时默认启用 **Developer Mode**，这与准备阶段的默认行为相反：

- Claude Code **可以使用项目配置，包括 `.env`**。无法读取配置的 agent 无法诊断配置问题。
- **原始密钥值不会写入 Yuhi 的日志、evidence、统计或 UI**，只记录类型、计数与不可逆指纹。
- **私钥、证书、恢复密钥与助记词在所有模式下都会被遮蔽**（仅遮蔽相应片段，文件其余部分仍会送达）。
- **在可能的范围内检测并审计直接再暴露**（回答、补丁、提交信息、外发请求中的再次出现）。
- **Egress 检测是绊线，而非完整的阻断控制**：仅匹配字面值。
- **Strict Mode 现在即可选择** — CLI 使用 `--delivery-mode strict`，VS Code 使用设置 `yuhi.dynamicContext.deliveryMode`。Strict Mode 在投递前遮蔽已检测到的密钥与受支持的标识符。检测覆盖范围取决于文件格式与内容。 这并不保证移除每一个密钥或标识符（记录级假名化适用于表格文件 `.csv` / `.tsv` / `.xlsx`；纯文本中缺少上下文的数字无法与其他数字区分）。

`yuhi prepare` 与 Safety Mode 的行为没有变化。

