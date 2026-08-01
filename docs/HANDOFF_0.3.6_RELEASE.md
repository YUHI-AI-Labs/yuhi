# v0.3.6 リリース引き継ぎ書

最終更新: 2026-08-02 / branch `feature/per-format-and-cleanup` @ `5187f5a`

## 1行で

**コードは出荷可能。リリースは未実行**で、残っているのは認証情報と手続きだけ。技術的ブロッカーはゼロ。

---

## 2. 現在の状態

### 完了している品質ゲート（ローカル macOS 実測）

```
tests        985 / 985 pass
typecheck    0 errors (12 packages)
lint         0 errors (18 warnings — すべて既存)
build        pnpm build / vscode build 成功
```

### セキュリティ P0（全件クローズ）

| ID | 内容 | 状態 |
|----|------|------|
| P0-A | secret redaction の no-op | PASS |
| P0-1 | 既知機微ドキュメントの原本配信 | PASS |
| — | 暗号化 ZIP の素通し | PASS |
| — | Safe Apply | PASS |
| P0-C | agent-visible metadata boundary | PASS（`135c0f2`） |

P0-C の検証は敵対的バイトスキャン：Balanced / Strict / Maximum Privacy × ドキュメント検査
あり/なしの全組み合わせで、agent が読める**全ファイルのバイトとファイル名**を走査し、
withheld ファイルの識別子 = 0 件。回帰テストは
`packages/core/src/metadata-boundary-e2e.test.ts`（構造投影を外すと落ちることを変異試験で確認済み）。

### 成果物

```
VSIX   apps/vscode/yuhi-vscode-0.3.6.vsix
sha256 cec6959b9eb3008afc35892eb8c1a42a348d470408b0d6be81a2d095344557dc
size   2,279,342 B / 10 files
inspect suspiciousEntries 0 / suspiciousContent 0 / compiler-free (0 hits)

CLI tarball  apps/cli/yuhi-ai-labs-yuhi-0.3.6.tgz（前セッション生成・未追跡）
```

VSIX はローカル成果物です。**Marketplace には上がっていません。**

---

## 3. リリースできていない理由（5件）

### 3.1 認証情報 — 最優先。これが無いと物理的に不可能

2026-08-02 に再実行した結果:

```
npm whoami                              → 401 Unauthorized
pnpm --filter @yuhi-ai-labs/yuhi publish → 404 / permission なし
vsce publish --packagePath …            → TF400813 (PAT invalid)
```

必要なもの:

- **npm トークン**（`@yuhi-ai-labs` scope への publish 権限）
- **vsce PAT**（Azure DevOps。Marketplace の publisher に紐づくもの）
- **ovsx トークン**（Open VSX。未設定）

### 3.2 CI がこのコードに一度も通っていない

最後の CI 実行は 2026-07-31 の `b33bcd2`（`pull_request` イベント）。
`.github/workflows/ci.yml` の push トリガーは `main` のみなので、
`a29d77b` / `135c0f2` / `5187f5a` は **CI 実行 0 件**。
`docs/PUBLISH_CHECKLIST.md` は 3 OS × Node 20/22 のグリーンを必須にしている。
現状の根拠は macOS 1 本のみ。→ **PR を立てるか `workflow_dispatch` で回す。**

### 3.3 main 未マージ

`feature/per-format-and-cleanup` は origin/main より **33 commits ahead**。
main はまだ 0.3.2 世代（`5177b73`）。

### 3.4 タグ未作成

`v0.3.6` なし。

### 3.5 補助成果物なし

SBOM (`sbom.json`)、`SHA256SUMS.txt`、GitHub Release ドラフトが未作成。

---

## 4. 再開手順

### Step 1 — CI を通す

```bash
gh pr create --base main --head feature/per-format-and-cleanup \
  --title "v0.3.6: Safe Patch Review + metadata boundary" --fill
# CI / CodeQL / Secret Scan の 3 本がグリーンになることを確認
gh pr checks --watch
```

### Step 2 — マージとタグ

```bash
gh pr merge --squash   # または --merge。履歴方針に合わせる
git checkout main && git pull
git tag v0.3.6 && git push origin v0.3.6
```

### Step 3 — publish（トークン投入後・不可逆）

```bash
# npm。ローカルからは --provenance は使えない（OIDC が必要）。
# provenance を付けるなら release.yml 経由の gated workflow で実行する。
npm login                       # または NPM_TOKEN を設定
pnpm --filter @yuhi-ai-labs/yuhi publish --access public

# VS Code Marketplace
export VSCE_PAT=<新しい PAT>
cd apps/vscode && npx vsce publish --packagePath yuhi-vscode-0.3.6.vsix

# Open VSX
npx ovsx publish apps/vscode/yuhi-vscode-0.3.6.vsix -p <ovsx token>
```

publish 前に VSIX の sha256 が上記と一致することを確認すること
（changelog を編集したら再パッケージ→ハッシュが変わる）。

### Step 4 — 公開後の確認

```bash
npm view @yuhi-ai-labs/yuhi          # latest が 0.3.6 になっているか
npx @yuhi-ai-labs/yuhi@latest --help
```

Marketplace / Open VSX でクリーンインストールを確認。

---

## 5. 参考情報

### npm の現状

```
latest = 0.3.1
beta   = 0.2.0-beta.2
```

CLI の 0.3.6 は latest への通常の bump になる。

### バージョンの整合

| パッケージ | version |
|---|---|
| `@yuhi-ai-labs/yuhi` (CLI) | 0.3.6 |
| `yuhi-vscode` | 0.3.6 |
| root `yuhi-monorepo` | 0.2.9（private。実害なしだが揃えてもよい） |
| `@yuhi/core` ほか内部 | 0.1.0（未公開ワークスペース） |

### 未追跡ファイル（コミット要否は判断してください）

```
apps/cli/yuhi-ai-labs-yuhi-0.3.6.tgz   ビルド成果物。追跡不要
benchmarks/                             未追跡
docs/LAUNCH_KIT.md                      未追跡
examples/compress-demo/                 未追跡
packages/core/_harness.mts              前セッションの検証ハーネス。捨ててよい
packages/core/_probe.mts                同上
```

---

## 6. P0-C で入った変更の要点（レビュー時の勘所）

中核は `packages/core/src/metadata-boundary.ts`。二層構造:

- **PRIVATE**（agent が見える場所に絶対に書かない / ローカル UI 用にメモリ内に保持）
  source relpath、`originalRelpath`、provenance `source`、絶対パス、run/source binding、
  background queue records。UI はユーザー自身のファイル名を表示してよい。
- **PUBLIC** — 配信済みファイルは（既に de-identify 済みの）名前をそのまま使う。
  **原本が配信されていないファイルは `documentId` + 種別のみの `displayName`
  (`doc-<hex>.pdf`) だけ。**

名前ではなく identity が境界を越えるので、件数・重複排除・Context Revision は正確なまま。
**除外の件数は今まで通り全部報告される。消えたのは名前だけ。**

塞いだ面:

- `manifest.json` — `originalRelpath` と provenance `source` を書かない
- `.yuhi/background-status.json` — 原本を配信した時だけ `relpath`
- 公開される companion — 公開 identity から命名（`<source>.md` を止めた）
- `.yuhi/context/<id>.summary.md` — identity 命名。`.yuhi/` はリネームパスの対象外なので
  source basename がそのまま残っていた
- `document-index.md` — 見出しに配信名を出す

Safe Apply の snapshot/hash 契約は不変（`relpath` と representation しか読まない）。
`omitted` エントリが representation を主張しないよう締めた分だけ厳しくなっている。

脅威モデルは `docs/THREAT_MODEL.md` の T15 と「The metadata boundary (v0.3.6)」節。

---

## 7. 既知の残存リスク（正直に）

- **配信されるファイル名の de-identify はトークン単位**で、意味的ではない。
  `田中太郎-report.pdf` のような人名はトークン規則では検出できない。
  T15 の residual risk に記載済み。
- Balanced は仕様通り、既知の findings が無い PDF の**原本を警告付きで配信する**
  （`CLAUDE.md` の製品原則）。原本を出したくない場合は Maximum Privacy を使う。
- CI 未実行のため、**Linux / Windows での挙動は未検証**。
