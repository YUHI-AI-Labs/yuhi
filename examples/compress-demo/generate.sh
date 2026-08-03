#!/usr/bin/env bash
# Generates a small, self-contained demo repository for a Yuhi v0.3.3 hands-on.
# It writes ONLY synthetic junk (fake keys, fake PII) — nothing real — into a
# throwaway directory you pass as $1 (default ./demo-repo). Reproducible: same
# inputs every run. Then use the steps in README.md to run `yuhi prepare --compress`.
set -eu
DIR="${1:-./demo-repo}"
rm -rf "$DIR"
mkdir -p "$DIR/src" "$DIR/data" "$DIR/dist"

# 1) A secret file — a well-known SYNTHETIC AWS example key (not a real credential).
cat > "$DIR/.env" <<'EOF'
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
DB_PASSWORD=hunter2
APP_NAME=demo
EOF

# 2) PII in a CSV (synthetic people).
cat > "$DIR/data/customers.csv" <<'EOF'
name,email,ssn
Tanaka Aoi,aoi@example.com,123-45-6789
Sato Ken,ken@example.com,987-65-4321
EOF

# 3) Build output + a large JSON (noise a coding agent doesn't need).
node -e 'let s="// generated bundle\n";for(let i=0;i<4000;i++)s+="var _"+i+"=function(a,b){return a+b+"+i+"};\n";require("fs").writeFileSync(process.argv[1],s)' "$DIR/dist/bundle.js"
node -e 'const o={records:[]};for(let i=0;i<3000;i++)o.records.push({id:i,label:"row "+i,value:Math.sin(i)});require("fs").writeFileSync(process.argv[1],JSON.stringify(o,null,2))' "$DIR/data/large.json"

# 4) A long TypeScript implementation (structure worth keeping, bodies not).
{
  echo '/** Order pricing + inventory service. */'
  echo 'export class OrderService {'
  echo '  constructor(private readonly taxRate: number) {}'
  for i in $(seq 1 60); do
    echo "  /** Compute step $i for an order. */"
    echo "  step$i(qty: number, unit: number, codes: string[]): number {"
    echo "    const parts = codes.map((c) => c.trim()).filter(Boolean);"
    echo "    let total = qty * unit * (1 + this.taxRate);"
    echo "    for (const p of parts) { total += p.length * qty - unit; if (total > 1e6) total %= 1e6; }"
    echo "    return Math.round(total + parts.reduce((a, p) => a + p.charCodeAt(0), 0));"
    echo "  }"
  done
  echo '}'
} > "$DIR/src/orders.ts"

# 5) A small entry point (MustKeep — stays full).
cat > "$DIR/src/index.ts" <<'EOF'
export { OrderService } from "./orders.js";
export const VERSION = "1.0.0";
EOF

# 6) A syntactically BROKEN TypeScript file (must be kept FULL, reason parse-failed).
cat > "$DIR/src/broken.ts" <<'EOF'
export const halfWritten = (a: number, b: number => {
  return a + b
EOF

# 7) Package manifest + agent instruction (MustKeep — stay full).
cat > "$DIR/package.json" <<'EOF'
{ "name": "demo-repo", "version": "1.0.0", "type": "module", "main": "src/index.ts" }
EOF
cat > "$DIR/CLAUDE.md" <<'EOF'
# Project instructions
This is a demo. Prefer small, focused changes.
EOF
cat > "$DIR/README.md" <<'EOF'
# Demo Repo
A tiny project used to demonstrate Yuhi context preparation.
EOF

echo "Demo repository written to: $DIR"
echo "Next: cd \"$DIR\" && yuhi init -y && yuhi prepare --compress"
