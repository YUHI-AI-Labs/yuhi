# Yuhi

<p align="center">
  <a href="https://www.npmjs.com/package/@yuhi-ai-labs/yuhi"><img alt="npm (beta)" src="https://img.shields.io/npm/v/@yuhi-ai-labs/yuhi/beta?label=npm%20%40beta&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/yuhi-ai-labs.yuhi-vscode?label=VS%20Code&color=007ACC&logo=visualstudiocode&logoColor=white"></a>
  <a href="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

**AI エージェントに見えているものを、そのまま確認する。**

Yuhi は、Claude Code、Codex CLI、Gemini CLI などのコーディングエージェント向けの、
ローカルファーストな **AI コンテキストランタイム** です。プロジェクトをスキャンし、
シンプルなポリシーを適用したうえで、生成・フィルタリングされたリポジトリのコピーの中で
エージェントを起動します。**元のファイルには一切手を加えません。**

```bash
yuhi preview      # exactly what the agent would see
yuhi run claude   # launch Claude Code inside the generated context
```

Git はリポジトリの状態を定義します。Docker は実行環境を定義します。**Yuhi は AI
コンテキストを定義します** — エージェントに渡す、最小で、最も安全で、そして最も*有用な*
プロジェクトのビューです。

> 🌐 他の言語でも利用できます: [English](./README.md) · [简体中文](./README.zh-CN.md)

---

## なぜ Yuhi なのか

作業ツリーの中で AI エージェントを起動すると、そこにあるものすべてを読み取れてしまいます
— `.env` ファイル、クラウド認証情報、顧客データ、非公開の仕様書まで。Yuhi を使えば、
**エージェントを起動する前にそのコンテキストを確認し、形づくる**ことができ、その後クリーンな
コピーの上でエージェントを実行します。

- **まずプレビュー。** `yuhi preview` は、エージェントが見えるファイルと見えないファイルを
  すべて表示します。
- **すべてを説明。** `yuhi explain path/to/file` は、どのルールがなぜマッチしたのかを教えます。
- **あなたのリポジトリには決して触れません。** Yuhi は `~/.yuhi/workspaces/<id>` にコピーし、
  元のリポジトリはそこから読み取り専用として扱われます。
- **シークレットや非公開データをコンテキストから除外** — あるいはコピー側でマスクします。
- **同じポリシー**を CLI と VS Code 拡張機能で利用できます — どこでも同じ語彙で。
- **テレメトリなし**、アカウント不要、オフラインで動作。Apache-2.0 ライセンス。

## クイックスタート(約 2 分)

```bash
# In your project (Node.js 20+):
npx @yuhi-ai-labs/yuhi init        # writes yuhi.yaml (respects .gitignore etc.)
npx @yuhi-ai-labs/yuhi preview     # see what an agent would see
npx @yuhi-ai-labs/yuhi run dummy   # try the whole flow offline with a bundled stand-in agent
npx @yuhi-ai-labs/yuhi run claude  # launch Claude Code in the generated context
```

> npm パッケージ名は **`@yuhi-ai-labs/yuhi`** です。現在のリリースは **beta** dist-tag です。
> `npx @yuhi-ai-labs/yuhi@beta preview` で明示的に beta を指定できます。ソースからビルドする場合は
> `pnpm install && pnpm build` の後に `node apps/cli/dist/index.js` を実行します。

`yuhi preview` の出力例:

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

## ポリシー: `yuhi.yaml`

小さく宣言的なファイルです(`schemas/yuhi.schema.json` によって検証され、エディタの
オートコンプリートがそのまま動作します):

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

アクション: `allow`、`block`、`redact`、`local-only`、`ask`(および計画中の
`metadata-only`、`summarize-local`)。複数のルールがマッチした場合は、**最も制限の強いものが
優先されます**。また、シークレットが検出されると、そのファイルは少なくとも `redact` へと
格上げされます。

## コマンド

| コマンド | 機能 |
|---|---|
| `yuhi init` | `yuhi.yaml` を作成(`.gitignore`、`.dockerignore` などを尊重) |
| `yuhi preview` | **看板となるコマンド** — エージェントが見るものを表示 |
| `yuhi scan` | ローカル検査: シークレットと機密ファイル(値は決して出力しない) |
| `yuhi explain <path>` | あるファイルが allow / block / redact / local-only になる理由 |
| `yuhi run <agent> [-- …]` | コンテキストを生成してエージェントを起動(`--` で引数を渡す) |
| `yuhi workspace list/inspect/clean` | 生成されたコンテキストを管理 |
| `yuhi audit list/show/export` | ローカルなメタデータのみの実行履歴 |
| `yuhi doctor` | 環境と設定をチェック |

`--json`、`--quiet`、`--no-color`、`--lang en|ja|zh-CN` はすべてのコマンドで利用できます。

## ⚠️ Yuhi にできること — そしてできないこと

Yuhi は **AI コンテキストの多層防御(defense-in-depth)であり、サンドボックスではありません。**
エージェントが起点とする*入力*を制御します。次のことは **行いません**:

- エージェントのネットワーク通信を傍受・遮断すること(エージェントがモデルプロバイダーに
  送信する内容は Yuhi の管理外です);
- OS レベルでエージェントのファイルシステムを封じ込めること(意図を持ったエージェントの
  プロセスは、依然として絶対パスを開いたり `..` をたどったりできます);
- データ漏洩がゼロであることを保証すること。

私たちは「100% 安全」や「漏洩ゼロを保証」といった主張を意図的に避けています。完全なモデルと、
オプションのサンドボックスバックエンド(Docker、`sandbox-exec`、bubblewrap、Windows Sandbox)に
向けたロードマップについては [`THREAT_MODEL.md`](./docs/THREAT_MODEL.md) を参照してください。

## 機能ステータス

| 領域 | ステータス |
|---|---|
| `init` / `scan` / `preview` / `explain` | **Stable(安定)** |
| セキュアなワークスペース生成 + リダクション | **Stable(安定)** |
| ポリシーエンジン(glob、優先順位、ディテクター) | **Stable(安定)** |
| `dummy` エージェント(オフライン) + Claude Code アダプター | **Stable(安定)** |
| ローカル監査ログ | **Stable(安定)** |
| Codex / Gemini アダプター | Planned(計画中) |
| VS Code 拡張機能(プレビュー・バッジ・実行) | **Beta**(VS Code Marketplace で公開) |
| ローカルモデル・ルート(`summarize-local`、`metadata-only`) | Planned(計画中・**v1.1**) |
| OS サンドボックスバックエンド | Not implemented(未実装、設計は `docs/THREAT_MODEL.md`) |

## アーキテクチャ

pnpm + TypeScript のモノレポです。コアは UI 非依存です(VS Code への依存はありません):

```
packages/  shared · config · policy · scanner · processors · workspace · agents · audit · core
apps/      cli · vscode
```

[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) および `docs/adr/` を参照してください。

## コントリビュート

Issue と PR を歓迎します — [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md) と
[`CODE_OF_CONDUCT.md`](./docs/CODE_OF_CONDUCT.md) を参照してください。エージェントの追加は多くの場合
設定エントリを 1 つ加えるだけで済みます。シークレットディテクターの追加も、小さくテスト可能な
変更です。

## ライセンス

[Apache-2.0](./LICENSE) — © Yuhi contributors. テレメトリなし。ローカルファースト。ベンダー中立。
