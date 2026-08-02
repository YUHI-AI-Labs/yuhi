# 開発引き継ぎ書（別マシンの Claude Code 向け）

最終更新: 2026-08-02 / `main` @ `a35719b` / v0.3.6 リリース完了直後

この文書は**別の Mac の Claude Code セッションが、この文書だけを読んで作業を再開できる**ことを
目的にしている。以後の開発は **Pull Request ベース**で進める。

---

## 1. プロジェクトの現在地

Yuhi は AI コーディングエージェント用の **Preparation Layer**。リポジトリのローカルコピーを作り、
エージェントに何を見せるかを決め、原本には触らず、最短で Yuhi Mode に入れる。

**v0.3.6 は完全にリリース済み。**

| 対象 | 状態 |
|---|---|
| npm `@yuhi-ai-labs/yuhi@0.3.6` | 公開済み（dist-tag `latest`。shasum `fc57bb7b58a7702b2e143bb751870858ae530f58`） |
| VS Code Marketplace `yuhi-ai-labs.yuhi-vscode` | 0.3.6 公開済み |
| tag `v0.3.6` | `38d8349`（軽量タグ。公開した npm / VSIX と同じツリー） |
| GitHub Release | 公開済み。asset に `yuhi-vscode-0.3.6.vsix` |
| CI | 9/9 green（Linux / macOS / Windows × Node 20, 22 + gitleaks + CodeQL） |
| Open VSX | **未公開**（ovsx トークン未設定） |
| SBOM / SHA256SUMS | **未生成** |

リリース経緯の詳細は [`HANDOFF_0.3.6_RELEASE.md`](HANDOFF_0.3.6_RELEASE.md)。

---

## 2. 新しい Mac のセットアップ

```bash
git clone https://github.com/YUHI-AI-Labs/yuhi.git
cd yuhi
corepack enable && corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
```

Node は `>=20`。**CI は 20 と 22 で回している**ので、ローカルもどちらかに合わせるのが安全
（前マシンは v26.5.0 で通っていたが CI の実測範囲外）。

### 検証コマンド（この4つが緑なら PR を出してよい）

```bash
pnpm test          # ← ルートの vitest。全 985 テスト。約 50 秒
pnpm -r typecheck  # 12 パッケージ
pnpm lint          # 0 errors / 18 warnings（warning は既存分）
pnpm build
```

> **落とし穴**: `pnpm -r test` は**何もせずに成功する**。個々のパッケージに `test` スクリプトが
> 無いため。テストは必ずルートの `pnpm test`（`vitest run`）で回す。
> 単体で回すなら `npx vitest run <path>`。

`packages/core/src/prepare-workspace.test.ts` に 20 秒級のスケールテストが 2 本あるので、
このファイル単独でも 45 秒前後かかる。ハングではない。

### 拡張機能の確認

```bash
cd apps/vscode && pnpm build
npx vsce package --no-dependencies -o yuhi-vscode-<version>.vsix
node scripts/inspect-vsix.mjs yuhi-vscode-<version>.vsix   # suspicious* が 0 であること
```

---

## 3. 作業ルール（PR ベース）

**`main` に直接 push しない。** 以後はすべて PR。

```bash
git checkout main && git pull
git checkout -b <type>/<short-topic>        # 例: fix/metadata-index-heading
# 実装 + テスト
pnpm test && pnpm -r typecheck && pnpm lint

git push -u origin <branch>
gh pr create --base main --title "..." --body "..."
gh pr checks --watch                        # 9 checks すべて pass を確認
gh pr merge --merge                         # squash ではなく merge（履歴と公開物の対応を保つ）
```

守ること:

- **CI が緑になる前にマージしない。** v0.3.6 の作業では CI 未実行のまま main 直前まで進んでしまい、
  PR #17 で初めて Linux / Windows を検証した。同じ穴を作らない。
- コミットメッセージは「何を直したか」ではなく**なぜそれが問題だったか**を書く。既存の履歴に倣う。
- リリース系の操作（npm publish / vsce publish / tag / GitHub Release）は**人間に渡す**。
  理由は §4 の権限の話。

---

## 4. 踏んだ地雷（ここが一番価値のある情報）

### 4.1 身元ルール（絶対）

**Yuhi / YUHI AI Labs の公開物に、実名・GitHub ハンドル・勤務先メールを出さない。**
git identity はリポジトリローカルの `user.email`（Apple の privaterelay アドレス）に設定済み。
グローバル設定とは別なので、`git config --local user.email` を確認してからコミットする。

`@users.noreply.github.com` に切り替える案は、そのアドレスにハンドル名が入る場合このルールと
衝突する。安易に変えない。

### 4.2 GH007（push が全部拒否される）

GitHub の Settings → Emails → **Block command line pushes that expose my email** が有効だと、
privaterelay アドレスを含む push が全部拒否される。

```
remote: error: GH007: Your push would publish a private email address.
```

2026-08-02 の作業中に有効化され、main もフィーチャーブランチも API 経由も止まった。
現在は OFF にしてもらっている。**再発したらこの設定を最初に確認する。**

### 4.3 注釈付きタグは tagger にメールを載せる

`git tag -a` で作ったタグは tagger オブジェクトにメールを持つため GH007 の対象になる。
**軽量タグ (`git tag <name> <sha>`) を使う**。tagger が無く、指す先のコミットが既に remote に
あれば送信オブジェクトが 0 になるので通る。

また `git tag -d` を忘れて作り直そうとすると `fatal: tag 'X' already exists` になり、
その後の push が**古い注釈付きタグを送ってしまう**。削除 → 作成 → push の順を崩さない。

### 4.4 Claude Code の権限分類器

`npm publish`、`git push origin <tag>`、`gh api -X PUT` などは auto mode の分類器に
ブロックされることがある。**回避を試みず、人間に渡す。**
コマンドをそのまま提示するのが正しい振る舞い。

### 4.5 npm / Marketplace の資格情報

- npm トークンは `apps/cli/.env` の `npm_token3`（**gitignore 済み・未追跡**）。
  値を出力やコミットに絶対に載せない。使うときは一時 `.npmrc` を `chmod 600` で作り、
  publish 後に削除する。
- `npm view` は CDN キャッシュ越しに古い版を返す。確認は `--prefer-online` か
  `curl -s https://registry.npmjs.org/@yuhi-ai-labs%2Fyuhi` を直読み。
- vsce PAT は失効しやすい（`TF400813`）。Azure DevOps で再発行が必要。
- `--provenance` はローカルからは付けられない（OIDC が必要）。付けるなら `release.yml` 経由。

---

## 5. 直近の実装（v0.3.6 の P0-C）を触るときの前提

中核は [`packages/core/src/metadata-boundary.ts`](../packages/core/src/metadata-boundary.ts)。

**不変条件**: 原本がエージェントに配信されていないファイルの**名前**は、prepared root 以下の
どのバイトにも現れてはならない。実データのファイル名自体が識別子だから
（`9999990001 評定-0722.xlsx`、`名簿-9999990001/`）。

二層構造:

- **PRIVATE** — source relpath、`originalRelpath`、provenance `source`、絶対パス、
  run/source binding、background queue records。agent-visible root の外か、ローカル UI 用の
  メモリ内のみ。UI はユーザー自身のファイル名を出してよい。
- **PUBLIC** — 配信済みファイルは（既に de-identify された）名前のまま。**未配信ファイルは
  `documentId` + 種別のみの `displayName` (`doc-<hex>.pdf`) だけ。**

名前ではなく identity が境界を越えるので、件数・重複排除・Context Revision は正確なまま。
**除外の件数は従来通り全部報告される。消えたのは名前だけ。**

### 新しい面を追加するときのチェックリスト

prepared root 以下に**何か書く**コードを足したら、必ず:

1. `publicSurface(...)` を通すか、構造的に identity だけを書くか、どちらかにする。
2. 生成物の**ファイル名**を source basename から作らない。`.yuhi/` 配下はファイル名の
   de-identify パス（`pseudonymizeIdentifierPath`）の**対象外**なので、そこに source 由来の
   名前を置くと識別子が生き残る。v0.3.6 でこれを 2 箇所踏んだ
   （companion の `<source>.md`、要約成果物の `<stem>.<hash>.summary.md`）。
3. [`metadata-boundary-e2e.test.ts`](../packages/core/src/metadata-boundary-e2e.test.ts) を回す。
   これは全 agent-visible ファイルのバイトとファイル名を走査する敵対的スキャンで、
   Balanced / Strict / Maximum Privacy × ドキュメント検査あり/なしを網羅している。
   面を足したら `METADATA_SURFACES` に追記する。

Safe Apply の snapshot/hash 契約は `relpath` と representation しか読まない。
ここを壊さないこと。脅威モデルは [`THREAT_MODEL.md`](THREAT_MODEL.md) の T15 と
「The metadata boundary (v0.3.6)」節。

---

## 6. 新しい Mac に**存在しない**ローカルファイル

前マシンに未コミットで残っている。clone しただけでは来ないので、扱いを決める必要がある。

| パス | 中身 | 推奨 |
|---|---|---|
| `benchmarks/` (20K) | ベンチ資材 | PR でコミット |
| `examples/compress-demo/` (4K) | 圧縮デモ | PR でコミット |
| `docs/LAUNCH_KIT.md` (8K) | ローンチ資材 | PR でコミット |
| `packages/core/_harness.mts` | 旧セッションの検証ハーネス | 破棄 |
| `packages/core/_probe.mts` | 同上 | 破棄 |
| `apps/cli/yuhi-ai-labs-yuhi-0.3.6.tgz` | npm pack 成果物 | 破棄 |

**前マシンを消す前に、上3つを PR で main に入れておくこと。** 判断は人間に確認する。

---

## 7. 次にやること — Phase 1 / v0.3.7 "Fast First Value"

[`ROADMAP.md`](ROADMAP.md) より。目標は**最初の有用な結果まで 30 秒以内**。

- activation / scan / 決定論的 preparation / Yuhi Mode readiness / launch を計測する。
- 目標: 小規模リポジトリ 10 秒未満、中規模 30 秒未満、大規模は可能な範囲で 60 秒未満。
- **ローカル限定の差分 preparation** を追加する。キーは相対パス、コンテンツ/ポリシーのハッシュ、
  safety / compression 設定、processor version。
- 変更なしの再 prepare を 5 秒未満にする。
- 公式の合成デモリポジトリ 1 本と、public-safe な preparation summary を用意する。

**v0.3.7 でやらないこと**: エージェント追加、AST パッチ、Git/PR の自動操作、
クラウドダッシュボード、MCP、新しい言語コンプレッサ。

ゲート: first-prepare 完了率 60% 超、prepare 中央値 30 秒未満、リピートユーザー 20 人以上。
未達なら v0.3.8 に進まず速度とオンボーディングを改善する。

Phase 0（v0.3.6 リリース安定化）の残りは Open VSX、SBOM、GUI/CLI の実機 E2E、
アップグレード確認、README / Marketplace / npm の表記一貫性。

---

## 8. 製品原則（実装判断で迷ったら）

[`CLAUDE.md`](../CLAUDE.md) が唯一の正。特に効くのは:

> Yuhi の成功指標は、すべてのファイルを完全に検査することではなく、安全なデフォルトを保ちながら、
> ユーザーを最短で Yuhi Mode の Claude Code へ到達させることである。

```
file blocked ≠ launch blocked
```

ファイル単位のリスク・除外・警告・バックグラウンド処理は、ワークスペース全体の起動を
止めてはならない。止めてよいのは workspace レベルの失敗だけ
（作成不能・出力検証不能・使えるワークスペースが無い・内部整合性検証の失敗・
サンドボックスポリシーの検証失敗）。

正直さの規約: 「完全に安全」「100% セキュア」「漏洩ゼロを保証」と書かない。
Yuhi は defense-in-depth であってサンドボックスではない。
"Estimated context reduction" を実測トークン消費や課金削減として説明しない。
