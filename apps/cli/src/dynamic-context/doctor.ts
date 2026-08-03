/**
 * `yuhi dynamic doctor` (spec §12).
 *
 * Every check is content-free and credential-free: presence is reported, values never
 * are. A check that cannot be performed reports `unknown` rather than guessing — a
 * doctor that lies is worse than no doctor.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

import { asSessionId, ContextStore } from "@yuhi/context-store";
import { jsonCompressor, defaultCompressContext } from "@yuhi/context-compression";
import { scanAndRedact } from "@yuhi/context-runtime";
import { createDefaultRegistry, DEFAULT_DETECT_TIMEOUT_MS, type AgentRegistry } from "@yuhi/agents";

import { credentialPresence, detectUpstream, type UpstreamConfig } from "./environment.js";
import { resolveRunForLaunch } from "../launch.js";

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly registry?: AgentRegistry;
  readonly port?: number;
  /** Skip the network reachability probe. */
  readonly offline?: boolean;
  readonly storeRoot?: string;
  readonly upstream?: UpstreamConfig;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly resolveRun?: typeof resolveRunForLaunch;
}

export async function runDynamicDoctor(opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const upstream = opts.upstream ?? detectUpstream(env);

  // 1. Claude executable
  try {
    const registry = opts.registry ?? createDefaultRegistry();
    const adapter = await registry.get("claude");
    const availability = await adapter.detect({ timeoutMs: DEFAULT_DETECT_TIMEOUT_MS });
    checks.push({
      name: "Claude executable",
      status: availability.available ? "ok" : "fail",
      detail: availability.available ? "found" : (availability.installHint ?? "not found"),
    });
  } catch {
    checks.push({ name: "Claude executable", status: "unknown", detail: "detection unavailable" });
  }

  // 2. Upstream mode + provider compatibility
  checks.push({
    name: "Upstream provider",
    status: upstream.supportsDynamicContext ? "ok" : "fail",
    detail: upstream.supportsDynamicContext
      ? `${upstream.mode} → ${upstream.baseUrl}`
      : (upstream.note ?? `${upstream.mode} does not support ANTHROPIC_BASE_URL`),
  });

  // 3. Gateway port availability
  checks.push(await checkPort(opts.port ?? 0));

  // 4. Upstream connectivity (auth is NOT validated: 401/403 still proves reachability)
  if (opts.offline || !upstream.supportsDynamicContext) {
    checks.push({ name: "Upstream connectivity", status: "unknown", detail: "skipped" });
  } else {
    checks.push(await checkConnectivity(upstream.baseUrl, opts.fetchImpl));
  }

  // 5. Authentication presence — never the value
  const creds = credentialPresence(env);
  const anyCredential = creds.apiKeyPresent || creds.authTokenPresent || creds.storedCredentialsPresent;
  checks.push({
    name: "Authentication present",
    status: anyCredential ? "ok" : "warn",
    detail: anyCredential
      ? `${[
          creds.apiKeyPresent ? "ANTHROPIC_API_KEY" : "",
          creds.authTokenPresent ? "ANTHROPIC_AUTH_TOKEN" : "",
          creds.storedCredentialsPresent ? "Claude Code stored credentials" : "",
        ]
          .filter((s) => s !== "")
          .join(", ")} detected (value not read)`
      : "no credential detected; Claude Code will prompt for login",
  });

  // 6-8. Context store writable, prefix-state persistence, MCP registration path
  const storeRoot = opts.storeRoot ?? join(await mkdtemp(join(tmpdir(), "yuhi-doctor-")), "context");
  try {
    const store = await ContextStore.open({ root: storeRoot });
    const probe = asSessionId("doctor-probe");
    await store.writeState(probe, "doctor", { at: "probe" });
    const roundTripped = (await store.readState<{ at: string }>(probe, "doctor"))?.at === "probe";
    const stored = await store.put(probe, '{"probe":true}', "json");
    const readBack = (await store.get(probe, stored.objectId)).toString("utf8");
    checks.push({
      name: "Context store writable",
      status: readBack === '{"probe":true}' ? "ok" : "fail",
      detail: storeRoot,
    });
    checks.push({
      name: "Prefix-state persistence",
      status: roundTripped ? "ok" : "fail",
      detail: roundTripped ? "state round-trips" : "state did not round-trip",
    });
  } catch (e) {
    checks.push({ name: "Context store writable", status: "fail", detail: (e as Error).name });
    checks.push({ name: "Prefix-state persistence", status: "fail", detail: "store unavailable" });
  }

  // 9. Static prepared workspace
  try {
    const resolution = await (opts.resolveRun ?? resolveRunForLaunch)(undefined);
    checks.push({
      name: "Static Prepared Workspace",
      status: resolution.ok ? "ok" : "warn",
      detail: resolution.ok ? "a launchable prepared run exists" : `none (${resolution.category}) — run \`yuhi prepare\``,
    });
  } catch {
    checks.push({ name: "Static Prepared Workspace", status: "unknown", detail: "resolution unavailable" });
  }

  // 10. Compression modules
  try {
    const ctx = defaultCompressContext();
    const content = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, v: "x".repeat(40) })) });
    const result = await jsonCompressor.compress(
      { objectId: "obj_00000000000000000000000000000000" as never, revision: 0, kind: "json", content },
      ctx,
    );
    checks.push({
      name: "Compression modules",
      status: result.tokensAfter < result.tokensBefore ? "ok" : "fail",
      detail: `json-outline ${result.tokensBefore}→${result.tokensAfter} est tokens`,
    });
  } catch (e) {
    checks.push({ name: "Compression modules", status: "fail", detail: (e as Error).name });
  }

  // 11. Safety scanner
  try {
    const scan = scanAndRedact("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    checks.push({
      name: "Safety scanner",
      status: scan.redactions > 0 ? "ok" : "fail",
      detail: scan.redactions > 0 ? `${scan.redactions} span(s) redacted on the fixture` : "fixture not detected",
    });
  } catch (e) {
    checks.push({ name: "Safety scanner", status: "fail", detail: (e as Error).name });
  }

  return checks;
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const symbol = (s: CheckStatus): string => (s === "ok" ? "✓" : s === "warn" ? "!" : s === "fail" ? "✗" : "?");
  const lines = ["Yuhi dynamic context — doctor", ""];
  for (const check of checks) lines.push(`${symbol(check.status)} ${check.name}: ${check.detail}`);
  const failures = checks.filter((c) => c.status === "fail").length;
  lines.push("");
  lines.push(
    failures === 0
      ? "Ready: `yuhi launch claude --dynamic-context`"
      : `${failures} blocking issue(s). Dynamic context will not start until they are resolved.`,
  );
  return lines.join("\n");
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((c) => c.status === "fail") ? 4 : 0;
}

async function checkPort(port: number): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () =>
      resolve({ name: "Gateway port", status: "fail", detail: `port ${port} is not bindable on 127.0.0.1` }),
    );
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = address && typeof address === "object" ? address.port : port;
      server.close(() =>
        resolve({
          name: "Gateway port",
          status: "ok",
          detail: port === 0 ? `loopback bind works (ephemeral ${bound})` : `port ${bound} available`,
        }),
      );
    });
  });
}

async function checkConnectivity(
  baseUrl: string,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<DoctorCheck> {
  const doFetch = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    // 401/403 means we reached the API and it declined an unauthenticated call.
    const reachable = response.status > 0;
    return {
      name: "Upstream connectivity",
      status: reachable ? "ok" : "fail",
      detail: `${baseUrl} responded ${response.status} (authentication not validated)`,
    };
  } catch (e) {
    return { name: "Upstream connectivity", status: "fail", detail: `unreachable (${(e as Error).name})` };
  }
}
