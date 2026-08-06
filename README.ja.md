<h1 align="center">Yuhi</h1>

<p align="center"><strong>どんなリポジトリも、AI-ready なリポジトリに。</strong></p>

<p align="center">Yuhi は、コーディングエージェントがリポジトリを見る前に、より小さく、よりクリーンで、より安全なワークスペースを準備します — そして、AI が何を見えるかを端末内で詳細にレビューでき、共有できるのは public-safe な集計要約です。</p>

> **現在のリリース: 0.4.0** — **Dynamic Context Runtime.** Claude Code をローカル Yuhi ゲートウェイ経由で実行し、tool result を安全・可逆・キャッシュ安定に圧縮します。既定は **Developer Mode**（下記）。

<p align="center">
  <a href="https://www.npmjs.com/package/@yuhi-ai-labs/yuhi"><img alt="npm (beta)" src="https://img.shields.io/npm/v/@yuhi-ai-labs/yuhi/beta?label=npm%20%40beta&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-code"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/yuhi-ai-labs.yuhi-code?label=VS%20Code&color=007ACC&logo=visualstudiocode&logoColor=white"></a>
  <a href="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

<p align="center">🌐 他の言語でも: <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a></p>

---

## ワンコマンド

```bash
npx @yuhi-ai-labs/yuhi prepare
```

Yuhi はリポジトリをローカルで検査し、削減・匿名化されたコピーを準備して、
**リポジトリレポート** を出力します — 共有できる、具体的で測定可能な結果です:

```text
Repository Ready

  Source files             5,224
  Prepared artifacts         317
  Documents prepared          42
  Secrets blocked             18
  Identifiers transformed    103

  Estimated accessible-content reduction: (リポジトリ構成に依存)

Ready for Claude Code.
```

> これらは **準備された初期コンテンツの推定値** です — リポジトリのうちどれだけが
> エージェントからアクセス可能になるか、という指標であり、モデルのトークン使用量やコストを
> 測定したものでは **ありません**。元のファイルは一切変更されません。

## ネイティブ Claude GUI (v0.4.1)

**公式Claude CodeのGUIを、そのままYuhi Dynamic Context経由で。**

**Yuhi: Open Claude Code Dynamic Workspace** で、Anthropic公式のClaude Code拡張が隔離された
VS Code環境で起動し、そのセッションが Yuhi Dynamic Context を通ります。Yuhiは独自のチャットUIを
作りません。

- 通常のVS Code環境とは分離（専用の `user-data-dir` と `extensions-dir`）
- 通常プロファイルへの影響なし
- Developer Mode / Strict Mode、CLIと同じポリシー
- 大きなツール出力を動的に圧縮し、省略部分は後から取得可能
- Window終了時に Gateway・MCP・session lock・Yuhi管理設定を自動クリーンアップ

**Yuhiはあなたの Claude 認証情報を読み取り・複製・保存しません。** 既存の Claude Code 認証は
利用できますが、**隔離環境内での初回サインインは未検証**です。

**既知の制約**: macOS で検証済み。Linux・Windows は実装・テスト済みですが実 GUI 未検証。
Remote SSH・WSL・Dev Containers・Codespaces は fail closed。Strict Mode の検出範囲はファイル形式と
内容に依存します。Dynamic reduction は provider token 全体やコストの削減率とは異なります。
絶対token数はフォールバックのヒューリスティックを使用しています。

詳細: [docs/design/V0_4_1_NATIVE_GUI.md](docs/design/V0_4_1_NATIVE_GUI.md) ·
[docs/V0_4_1_RELEASE_SCOPE.md](docs/V0_4_1_RELEASE_SCOPE.md)

## リポジトリのうち、AI が本当に必要とする分はどれだけか

コーディングエージェントは作業ツリーの中で起動し、そこにあるものすべてを読み取れます
— `.env` ファイル、クラウド認証情報、顧客データ、巨大なビルド成果物、バイナリの塊まで。
その多くはエージェントに必要なコンテキストではなく、一部はエージェントが持つべきでないものです。

Yuhi はシンプルな問いに答えます — *このリポジトリのうち、AI が本当に見るべきはどれだけか?* —
そして、まさにその分だけを準備します:

- **シークレットを遮断。** 認証情報や秘密鍵はローカルで無害化され、エージェントには決して渡されません。
- **ドキュメントを AI 向けのコンテンツに変換。** 対応ドキュメント（PDF / DOCX / PPTX）はサニタイズされた Markdown の相方になります。安全な準備が検証できない場合は、元ファイルは端末内に保持されるか安全なプレースホルダに置き換えられ、原本がエージェントに渡ることはありません。
- **リポジトリを本当に必要な分まで削減。** 過大なファイル、バイナリ、無関係なファイルはローカルに留め、送信しません。
- **ワンコマンドで Claude Code を準備。** Prepared Workspace にエージェントを向けて、すぐに開始できます。

## 結果を共有する

このレポートこそが本質です。どの形式も **公開しても安全** です — 集計された数値のみで、
ファイル名、パス、シークレットの種類、身元は一切含みません — README や PR、投稿にそのまま貼れます:

```bash
yuhi report <run> --format markdown   # a table for your README or PR
yuhi report <run> --format json       # machine-readable, for CI
yuhi report <run> --format svg        # a "Prepared with Yuhi" badge with your run's own numbers
```

バッジを README に貼りましょう:

```bash
yuhi report <run> --format svg > .github/yuhi-badge.svg
```

```md
![Prepared with Yuhi](.github/yuhi-badge.svg)
```

あるいは CI に自動投稿させることもできます — [Yuhi report GitHub Action](./actions/yuhi-report) は、
各実行の Job Summary に **リポジトリレポート** を書き込みます(レポート専用。PR のゲートも書き込み権限もありません)。

## Claude Code を開く

**VS Code で** — [Yuhi 拡張機能](https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-code)
をインストールし、**`Yuhi: Prepare and Start Claude Code`** を実行します。Yuhi がワークスペースを
準備・レビューし、公式の `anthropic.claude-code` 拡張機能向けに、**Prepared by Yuhi** と表示された
新しいウィンドウで Prepared Workspace を開きます。

**CLI では** — `yuhi prepare` と `yuhi report` が利用できます。エージェントの起動は現在 VS Code 拡張からサポートしています。

> Yuhi が準備するのは *初期コンテキスト* です。OS レベルのサンドボックスでは **ありません**:
> エージェントは、そのランタイムやあなたが許可すれば、Prepared Workspace の外のパスにアクセスできる場合があります。
> [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) を参照してください。

## しくみ

```text
Scan   →  inspect the repository locally for secrets, PII, documents, and noise
Prepare→  neutralize secrets, de-identify tables, convert documents, drop what isn't needed
Verify →  rescan the delivered artifacts before anything is handed off (fail-closed)
Report →  a public-safe Repository Report — terminal / Markdown / JSON / SVG
```

すべては **あなたのマシン上** で動作します。テレメトリなし、アカウント不要、オフラインで動作します。
元のファイルは Yuhi にとって読み取り専用であり、準備済みのコピーは管理されたワークスペースディレクトリの下に置かれます。

## Yuhi にできること — そしてできないこと

Yuhi は **AI コンテキストの多層防御(defense-in-depth)であり、サンドボックスではありません。**
エージェントが起点とする *入力* を制御します。次のことは **行いません**:

- エージェントのネットワーク通信を傍受・遮断すること(エージェントがモデルプロバイダーに送信する内容は Yuhi の管理外です);
- OS レベルでエージェントのファイルシステムを封じ込めること(意図を持ったエージェントのプロセスは、依然として絶対パスを開いたり `..` をたどったりできます);
- データ漏洩がゼロであることを保証すること。

私たちは「100% 安全」や「漏洩ゼロを保証」といった主張を意図的に避けています。完全なモデルと、
オプションのサンドボックスバックエンド(Docker、`sandbox-exec`、bubblewrap、Windows Sandbox)に
向けたロードマップについては [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) を参照してください。

## コマンド

| コマンド | 機能 |
|---|---|
| `yuhi prepare [dir]` | **看板となるコマンド** — 削減・匿名化されたコピーを準備し、リポジトリレポートを出力 |
| `yuhi report <run> [--format …]` | 共有可能で公開しても安全なリポジトリレポートを出力(terminal / markdown / json / svg) |
| `yuhi init` | `yuhi.yaml` を作成(`.gitignore`、`.dockerignore` などを尊重) |
| `yuhi scan` | ローカル検査: シークレットと機密ファイル(値は決して出力しない) |
| `yuhi status` | AI コンテキストをひと目で — `git status` のように |
| `yuhi preview` | エージェントが見るものを正確に表示 |
| `yuhi explain <path>` | あるファイルが準備・遮断・リダクト・ローカル保持される理由 |
| `yuhi doctor` | 環境と設定をチェック |

`--json`、`--quiet`、`--no-color`、`--lang en|ja|zh-CN` はすべてのコマンドで利用できます。
上級者向け: `yuhi workspace list/inspect/clean`、`yuhi review <run>`、`yuhi audit list/show/export`。

> npm パッケージ名は **`@yuhi-ai-labs/yuhi`** です(現在のリリースは **beta** dist-tag —
> `@yuhi-ai-labs/yuhi@beta` でピン留めできます)。ソースからビルドする場合は `pnpm install && pnpm build` の後に
> `node apps/cli/dist/index.js` を実行します。

## ポリシー: `yuhi.yaml`

小さく宣言的なファイルです(`schemas/yuhi.schema.json` によって検証され、エディタの
オートコンプリートがそのまま動作します)。`yuhi init` が書き出すファイルには妥当なデフォルトが含まれており、編集が必要になることはほとんどありません:

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

複数のルールがマッチした場合は、**最も制限の強いものが優先されます**。また、シークレットが
検出されると、そのファイルは少なくとも `redact` へと格上げされます。

## アーキテクチャ

pnpm + TypeScript のモノレポです。コアは UI 非依存です(VS Code への依存はありません):

```
packages/  shared · config · policy · scanner · processors · workspace · agents · audit · core
apps/      cli · vscode
```

[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) および `docs/adr/` を参照してください。

## プロジェクトの方向性

- [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — Yuhi が守るもの、守 **らない** もの。
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — コードベースの構成。

## コントリビュート

Issue と PR を歓迎します — [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md) と
[`CODE_OF_CONDUCT.md`](./docs/CODE_OF_CONDUCT.md) を参照してください。エージェントの追加は多くの場合
設定エントリを 1 つ加えるだけで済みます。シークレットディテクターの追加も、小さくテスト可能な変更です。

## ライセンス

[Apache-2.0](./LICENSE) — © Yuhi contributors. テレメトリなし。ローカルファースト。ベンダー中立。


## 動的コンテキスト (v0.4.0)

`yuhi launch claude --dynamic-context`、または VS Code の **Yuhi: Start Claude Code with Dynamic Context** で、Claude Code をローカルゲートウェイ経由で起動します。新しい tool result は毎回、非公開に保存 → スキャン → 圧縮 → 再スキャンを経てからプロバイダへ送られ、省略した部分は常に取得可能なまま残ります。

コンテキスト削減量はリポジトリ構成・タスク・モデル・キャッシュ挙動・retrieval 設定により変わります。測定方法の詳細はベンチマークレポートに記載しています。数値は v0.5 で再測定予定です。

### タスク認識型生成 (v0.5.0、既定は Observe)

Yuhi は実行時にタスクを意識したコンテキスト表現を生成できます。Planner が tool result ごとに、フル配信・構造化表現・取得可能な省略区間を持つウィンドウ・エージェントが後から取得する参照・直前と同一内容の再利用のいずれにするかを決定します。Planner 自体はコンテンツを書き換えず、どの結果も既存の compressor と retrieval 経路を通ります。既定を上げる前に効果を測定する方針のため、`--generation-mode`（CLI）/ `yuhi.dynamicContext.generationMode`（VS Code、Advanced）の既定は `observe` です。これは Planner の判断を記録するだけで、実際の配信内容は変更しません。`active` はオプトインであり、まだ既定ではありません — コスト・トークン数・速度についての主張は行っていません。詳細は [docs/design/0.5.0_dynamic_generation.md](docs/design/0.5.0_dynamic_generation.md)。

### Developer Mode

動的ランタイムの既定は **Developer Mode** です。準備時の既定とは意図的に逆になります。

- Claude Code は **`.env` を含むプロジェクト設定を利用できます**。設定を読めないエージェントは設定を診断できません。
- **生のシークレット値は Yuhi のログ・evidence・統計・UI に一切書かれません**。記録されるのは種別・件数・不可逆なフィンガープリントだけです。
- **秘密鍵・証明書・リカバリキー・シードフレーズはどのモードでもマスク**されます（該当スパンのみ。ファイルの残りはエージェントに届きます）。
- **直接的な再露出は可能な範囲で検知・監査**します（応答・パッチ・コミット本文・外向きリクエストへの再出現）。
- **Egress 検知はトリップワイヤであり、完全な防止機構ではありません**。リテラル一致のみで、言い換えや再エンコードは検知しません。
- **Strict Mode は今すぐ選べます** — CLI は `--delivery-mode strict`、VS Code は設定 `yuhi.dynamicContext.deliveryMode`。Strict Mode は、検出されたシークレットとサポート対象の識別子を配信前にマスクします。検出範囲はファイル形式と内容に依存します。 すべてのシークレット・識別子が除去される保証ではありません（レコード単位の疑似化は表形式 `.csv` / `.tsv` / `.xlsx` が対象で、プレーンテキスト中の文脈のない数値は他の数値と区別できません）。

`yuhi prepare` と Safety Mode の挙動は変更ありません。

