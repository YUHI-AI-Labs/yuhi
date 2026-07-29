#!/usr/bin/env bash
# Apply the curated label set in .github/labels.yml to a GitHub repo.
# Usage: scripts/apply-labels.sh [owner/repo]   (defaults to YUHI-AI-Labs/yuhi)
# Requires: gh (authenticated), node.
set -euo pipefail

REPO="${1:-YUHI-AI-Labs/yuhi}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABELS="$ROOT/.github/labels.yml"

command -v gh >/dev/null || { echo "gh CLI is required"; exit 1; }
[ -f "$LABELS" ] || { echo "missing $LABELS"; exit 1; }

echo "Applying labels to $REPO ..."
# Parse the simple labels.yml (name/color/description triples) without a YAML dep.
node -e '
const fs=require("fs");
const txt=fs.readFileSync(process.argv[1],"utf8");
const out=[];let cur=null;
for(const raw of txt.split(/\r?\n/)){
  const line=raw.replace(/\s+$/,"");
  let m;
  if((m=line.match(/^- name:\s*"?(.*?)"?\s*$/))){cur={name:m[1]};out.push(cur);}
  else if(cur&&(m=line.match(/^\s+color:\s*"?(.*?)"?\s*$/)))cur.color=m[1];
  else if(cur&&(m=line.match(/^\s+description:\s*"?(.*?)"?\s*$/)))cur.description=m[1];
}
process.stdout.write(out.map(l=>[l.name,l.color||"ededed",l.description||""].join("\t")).join("\n"));
' "$LABELS" | while IFS=$'\t' read -r name color desc; do
  [ -z "$name" ] && continue
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null \
    && echo "  ✓ $name"
done
echo "Done."
