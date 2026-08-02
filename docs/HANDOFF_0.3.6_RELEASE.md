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

## 3. 公開状況（2026-08-02 時点）

| 対象 | 状態 |
|---|---|
| npm `@yuhi-ai-labs/yuhi@0.3.6` | **公開済み**（dist-tag `latest`。shasum `fc57bb7b58a7702b2e143bb751870858ae530f58`） |
| VS Code Marketplace `yuhi-ai-labs.yuhi-vscode` | **0.3.6 公開済み**（メンテナ実施） |
| main へのマージ | **完了**（PR #17 → `38d8349`） |
| CI | **9/9 green**（Linux / macOS / Windows × Node 20, 22 + gitleaks + CodEQL） |
| タグ `v0.3.6` | **未 push** — GH007 でブロック中。下記 4.1 参照 |
| GitHub Release | **未作成** — ノートは `docs/RELEASE_NOTES_0.3.6.md` に用意済み |
| Open VSX | 未公開（ovsx トークン未設定） |
| SBOM / SHA256SUMS | 未生成 |

npm は `--provenance` なしで公開されている（ローカル実行では OIDC が使えないため）。
provenance が必要なら次回以降 `release.yml` 経由の gated workflow で publish する。

## 4. 再開手順

### 4.1 GH007 の解除（最初にこれ）

2026-08-02 の作業中に GitHub の
Settings → Emails → **Block command line pushes that expose my email** が有効になり、
`ndrg7bmfjw@privaterelay.appleid.com` を含む push が全部拒否されるようになった
（同じメールでこの日の午前中は 3 回 push できていたので、途中で設定が変わっている）。

対処はどちらか:

- 上記設定を OFF にする（最短。従来どおり push できる）
- git の committer を GitHub の `@users.noreply.github.com` アドレスに変える。
  **ただし noreply アドレスにハンドル名が入る場合は公開物に出ないよう注意**
  （`docs/` の方針: Yuhi の公開物に実名・ハンドルを出さない）

既に remote にあるコミットは privaterelay のままで問題ない。影響するのは新規 push だけ。

### 4.2 タグ

ローカルに**注釈付き**タグ `v0.3.6` が残っている。tagger オブジェクトがメールを持つため
GH007 の対象になる。軽量タグに置き換えると tagger が無くなり、
かつ指す先のコミットは既に remote にあるので送信オブジェクトが 0 になる。

```bash
git tag -d v0.3.6                 # 注釈付きを消す（これを飛ばすと "already exists" で失敗する）
git tag v0.3.6 38d8349            # 軽量タグ
git push origin v0.3.6
```

### 4.3 未 push のコミット

`docs/RELEASE_NOTES_0.3.6.md` と本書の更新がローカル main に積まれている。
4.1 を済ませてから:

```bash
git push origin main
```

### 4.4 GitHub Release

タグを push したあと:

```bash
gh release create v0.3.6 --title "Yuhi v0.3.6" \
  --notes-file docs/RELEASE_NOTES_0.3.6.md \
  apps/vscode/yuhi-vscode-0.3.6.vsix
```

### 4.5 残りの任意作業

```bash
# Open VSX
npx ovsx publish apps/vscode/yuhi-vscode-0.3.6.vsix -p <ovsx token>

# SBOM と checksum
npx @cyclonedx/cyclonedx-npm --output-file sbom.json
shasum -a 256 apps/vscode/yuhi-vscode-0.3.6.vsix apps/cli/*.tgz > SHA256SUMS.txt
```

npm トークンは `apps/cli/.env` の `npm_token3`（gitignore 済み・未追跡・有効を確認済み）。

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
