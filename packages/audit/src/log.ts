import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { auditDir, YuhiError, type AuditRecord } from "@yuhi/shared";

function logPath(): string {
  return path.join(auditDir(), "log.jsonl");
}

function ensureDir(): void {
  const dir = auditDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700); // best-effort restrictive perms
  } catch {
    /* ignore */
  }
}

/**
 * Append a metadata-only audit record. By contract (THREAT_MODEL T14 / Audit
 * section) this NEVER contains file contents, prompts, responses, or secret
 * values — the AuditRecord type does not carry them.
 */
export function writeAudit(record: AuditRecord): void {
  ensureDir();
  const line = JSON.stringify(record) + "\n";
  if (existsSync(logPath())) appendFileSync(logPath(), line, { mode: 0o600 });
  else writeFileSync(logPath(), line, { mode: 0o600 });
}

export function listAudit(limit?: number): AuditRecord[] {
  if (!existsSync(logPath())) return [];
  const lines = readFileSync(logPath(), "utf8").split("\n").filter(Boolean);
  const records: AuditRecord[] = [];
  for (const l of lines) {
    try {
      records.push(JSON.parse(l) as AuditRecord);
    } catch {
      /* skip malformed line */
    }
  }
  records.reverse(); // newest first
  return typeof limit === "number" ? records.slice(0, limit) : records;
}

export function showAudit(id: string): AuditRecord {
  const rec = listAudit().find((r) => r.id === id || r.id.startsWith(id));
  if (!rec) {
    throw new YuhiError("INTERNAL", `No audit record with id "${id}".`, {
      hint: "Run `yuhi audit list` to see recorded runs.",
    });
  }
  return rec;
}

export function exportAudit(id: string, format: "json" = "json"): string {
  const rec = showAudit(id);
  if (format === "json") return JSON.stringify(rec, null, 2);
  return JSON.stringify(rec, null, 2);
}

/** Remove records older than `retentionDays`. Returns count removed. */
export function pruneAudit(retentionDays: number): number {
  if (!existsSync(logPath())) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const all = listAudit();
  const kept = all.filter((r) => {
    const t = Date.parse(r.timestamp);
    return Number.isNaN(t) || t >= cutoff;
  });
  const removed = all.length - kept.length;
  if (removed > 0) {
    // rewrite oldest-first
    const body = kept.reverse().map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(logPath(), body ? body + "\n" : "", { mode: 0o600 });
  }
  return removed;
}
