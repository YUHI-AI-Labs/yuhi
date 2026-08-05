import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { cliVersion } from "./version.js";
import {
  YuhiError,
  isYuhiError,
  MODEL_TIERS,
  RECOMMENDED_MODELS,
  DEFAULT_LOCAL_MODEL,
  type WorkspaceManifest,
} from "@yuhi/shared";
import {
  resolvePrivacyPolicy,
  privacyModeCopyFor,
  PrivacyModeResolutionError,
  type PrivacyMode,
} from "@yuhi/shared";
import {
  runInit,
  computePlan,
  buildPreview,
  explainFromPlan,
  diffContext,
  contextSavings,
  prepareWorkspace,
  assertSafeSourceWorkspace,
  resolvePreparedRunReference,
  readPreparedRunSession,
  writePreparedRunSession,
  runBackgroundForRun,
  createWorkspaceForDir,
  listWorkspaces,
  inspectWorkspace,
  cleanWorkspace,
  cleanAllWorkspaces,
  listAudit,
  showAudit,
  exportAudit,
  KNOWN_AGENT_IDS,
  buildAdapter,
  formatPreparationReport,
  formatCompressionReport,
  isSafetyMode,
  safetyModeLabel,
  type SafetyMode,
} from "@yuhi/core";
import { loadConfig, resolveSafetyMode } from "@yuhi/config";
import { createLocalModelProvider } from "@yuhi/local";
import { lookupOnPath } from "@yuhi/agents";
import { createTranslator, resolveLang, type Translator } from "./i18n.js";
import { configureColor, ui, symbols, heading, yuhiBanner } from "./ui.js";
import {
  renderScan,
  renderPreview,
  renderExplain,
  renderStatus,
  renderDiff,
  renderModelTiers,
} from "./render.js";
import { confirm } from "./prompt.js";
import { runDoctor, renderDoctor } from "./doctor.js";
import {
  providerConfigFromSettings,
  isModelInstalled,
  fetchInstalledTags,
  pullModel,
  smokeTest,
  writeModelToConfig,
  installHintForPlatform,
  OLLAMA_DOWNLOAD_URL,
} from "./local-ai.js";
import {
  buildCliPrepareResult,
  cliPrepareExitCode,
  formatCliPrepareResult,
} from "./prepare-output.js";
import { performLaunch } from "./launch.js";
import {
  performBackgroundStatus,
  performBackgroundStart,
  performBackgroundCancel,
  performBackgroundRetry,
  maybeWaitBackground,
  readRefreshedYuhiModeSummary,
} from "./background.js";
import {
  patchApply,
  patchDiff,
  patchDiscard,
  patchHistoryCommand,
  patchStatus,
  patchUndoCommand,
  patchValidate,
} from "./patch.js";

interface Globals {
  json: boolean;
  quiet: boolean;
  color: boolean;
  verbose: boolean;
  lang?: string;
  cwd: string;
}

/** Everything after a literal `--` is forwarded verbatim to the launched agent. */
function splitForwarded(argv: string[]): { main: string[]; forwarded: string[] } {
  const idx = argv.indexOf("--");
  if (idx === -1) return { main: argv, forwarded: [] };
  return { main: argv.slice(0, idx), forwarded: argv.slice(idx + 1) };
}

function getContext(cmd: Command): { g: Globals; t: Translator; dir: string } {
  const g = cmd.optsWithGlobals() as Globals;
  configureColor(g.color !== false);
  const t = createTranslator(resolveLang(g.lang));
  return { g, t, dir: g.cwd ?? "." };
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Wrap a command action with uniform error handling + exit codes. */
function action(handler: (cmd: Command) => Promise<number | void>) {
  return async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    try {
      const code = await handler(cmd);
      process.exitCode = typeof code === "number" ? code : 0;
    } catch (err) {
      const g = cmd.optsWithGlobals() as Globals;
      if (isYuhiError(err)) {
        if (g.json) printJson({ error: err.code, message: err.message, hint: err.hint });
        else {
          console.error(`\n${symbols.err()} ${ui.bold(err.code)}: ${err.message}`);
          if (err.hint) console.error(ui.dim(`  → ${err.hint}`));
        }
        process.exitCode = err.exitCode;
      } else {
        console.error(`\n${symbols.err()} Unexpected error: ${(err as Error).message}`);
        if (g?.verbose) console.error(err);
        process.exitCode = 1;
      }
    }
  };
}

async function main(): Promise<void> {
  const { main: mainArgv, forwarded } = splitForwarded(process.argv);

  const program = new Command();
  program
    .name("yuhi")
    .description("Yuhi — an AI Context Runtime. See exactly what your AI agent can see.")
    .version(cliVersion(), "-v, --version")
    .option("--json", "output machine-readable JSON", false)
    .option("-q, --quiet", "reduce output", false)
    .option("--no-color", "disable colored output")
    .option("--verbose", "verbose errors", false)
    .option("--lang <lang>", "language: en | ja | zh-CN")
    .option("-C, --cwd <dir>", "project directory", ".");

  // ---- init ----
  program
    .command("init")
    .description("Initialize Yuhi in this project (writes yuhi.yaml)")
    .option("-y, --yes", "accept defaults (non-interactive)", false)
    .option("--force", "overwrite an existing yuhi.yaml", false)
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const opts = cmd.opts();
        const res = runInit(dir, { force: opts.force });
        if (g.json) return void printJson(res);
        if (res.alreadyExisted) {
          console.log(`${symbols.warn()} ${t("init.exists")}`);
          return;
        }
        console.log(heading("Yuhi"));
        for (const f of res.created) console.log(`${symbols.ok()} ${t("init.created", { file: f })}`);
        console.log("\n" + ui.dim(t("init.next")));
      }),
    );

  // ---- status ----
  program
    .command("status")
    .description("Show the current AI context at a glance (like `git status`)")
    .option("--agent <id>", "for a specific agent")
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const opts = cmd.opts();
        const plan = await computePlan(dir, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          interactive: false,
        });
        const preview = buildPreview(plan);
        const diff = diffContext(plan);
        const savings = contextSavings(plan);
        if (g.json)
          return void printJson({ summary: preview.summary, agent: preview.agent, savings, diff });
        renderStatus(preview, savings, diff.changes.length, diff.hasPrevious, t);
      }),
    );

  // ---- diff ----
  program
    .command("diff")
    .description("Show what changed in the AI context since the last run")
    .option("--agent <id>", "for a specific agent")
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const opts = cmd.opts();
        const plan = await computePlan(dir, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          interactive: false,
        });
        const diff = diffContext(plan);
        if (g.json) return void printJson(diff);
        renderDiff(diff.changes, diff.hasPrevious, t);
      }),
    );

  // ---- scan ----
  program
    .command("scan")
    .description("Inspect the project locally for secrets and sensitive files")
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const plan = await computePlan(dir, { interactive: false });
        if (g.json) return void printJson(plan.scan);
        renderScan(plan.scan, t);
      }),
    );

  // ---- inspect documents ----
  program
    .command("inspect")
    .description("Inspect supported documents locally without persisting extracted text")
    .action(
      action(async (cmd) => {
        const { g, dir } = getContext(cmd);
        const plan = await computePlan(dir, { interactive: false });
        const documents = plan.scan.files.filter((file) => file.documentInspection);
        const result = {
          documents: documents.length,
          pdf: documents.length,
          textExtraction: documents.filter(
            (file) => file.documentInspection?.extractionMethod === "pdf-text",
          ).length,
          ocr: documents.filter(
            (file) => file.documentInspection?.extractionMethod === "ocr",
          ).length,
          summary: 0,
          warnings: documents.filter(
            (file) => file.documentInspection?.status !== "inspected",
          ).length,
          note: "Inspection is local. Run `yuhi prepare` to generate verified local summaries.",
        };
        if (g.json) return void printJson(result);
        console.log(heading("Document inspection"));
        console.log(`  Documents: ${result.documents}`);
        console.log(`  PDF: ${result.pdf}`);
        console.log(`  Text extraction: ${result.textExtraction}`);
        console.log(`  OCR: ${result.ocr}`);
        console.log(`  Summary: ${result.summary}`);
        console.log(`  Warnings: ${result.warnings}`);
        console.log(`\n${ui.dim(result.note)}`);
      }),
    );

  // ---- preview ----
  program
    .command("preview")
    .description("Show exactly what an AI agent would see (the signature command)")
    .option("--agent <id>", "preview for a specific agent")
    .option("--explain <path>", "explain the decision for one file")
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const opts = cmd.opts();
        const plan = await computePlan(dir, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          interactive: false,
        });
        if (opts.explain) {
          const d = explainFromPlan(plan, opts.explain);
          if (!d) throw notFound(t, opts.explain);
          if (g.json) return void printJson(d);
          return void renderExplain(d, t);
        }
        const preview = buildPreview(plan);
        if (g.json) return void printJson(preview);
        renderPreview(preview, t);
        if (!g.quiet) console.log("\n" + ui.dim(t("limitation")));
      }),
    );

  // ---- explain ----
  program
    .command("explain <path>")
    .description("Explain why a file is allowed, blocked, redacted, or kept local")
    .option("--agent <id>", "use a specific agent's view")
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const opts = cmd.opts();
        const target = cmd.args[0]!;
        const plan = await computePlan(dir, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          interactive: false,
        });
        const d = explainFromPlan(plan, target);
        if (!d) throw notFound(t, target);
        if (g.json) return void printJson(d);
        renderExplain(d, t);
      }),
    );

  // ---- run ----
  program
    .command("run [agent]")
    .description("Temporarily disabled in the 0.2.2 early preview")
    .option("--dry-run", "prepare the workspace but do not launch", false)
    .option("--cleanup <mode>", "prompt | always | never")
    .option("--no-preview", "skip printing the preview before launching")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const result = {
          command: "run",
          status: "Disabled",
          launchAllowed: false,
          agentStarted: false,
          safeErrorCategory: "cli-agent-launch-disabled",
        };
        if (g.json) printJson(result);
        else {
          console.error(
            "CLI agent launch is temporarily disabled in the 0.2.2 early preview.\n\n" +
            "Use the Yuhi VS Code preparation and Claude Code handoff workflow.",
          );
        }
        return 4;
      }),
    );

  // ---- workspace ----
  const ws = program.command("workspace").description("Manage generated workspaces");
  ws.command("create")
    .description("Create a workspace without launching an agent")
    .option("--agent <id>")
    .option("--dry-run", "compute without writing", false)
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const opts = cmd.opts();
        const res = await createWorkspaceForDir(dir, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          dryRun: Boolean(opts.dryRun),
          interactive: false,
        });
        if (g.json) return void printJson(res.manifest);
        console.log(
          `${symbols.ok()} ${t("workspace.created", { id: res.manifest.id, path: res.manifest.workspacePath })}`,
        );
        for (const w of res.warnings) console.log(`${symbols.warn()} ${w}`);
      }),
    );
  ws.command("list")
    .description("List generated workspaces")
    .action(
      action(async (cmd) => {
        const { g, t } = getContext(cmd);
        const list = listWorkspaces();
        if (g.json) return void printJson(list);
        if (list.length === 0) return void console.log(t("workspace.none"));
        console.log(heading("Workspaces"));
        for (const w of list) {
          console.log(`  ${ui.bold(w.id)}  ${ui.dim(w.createdAt)}  ${w.agent}  ${ui.dim(w.sourcePath)}`);
        }
      }),
    );
  ws.command("inspect <id>")
    .description("Show a workspace manifest")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const m: WorkspaceManifest = inspectWorkspace(cmd.args[0]!);
        if (g.json) return void printJson(m);
        console.log(heading(`Workspace ${m.id}`));
        console.log(`Agent: ${m.agent}`);
        console.log(`Created: ${m.createdAt}`);
        console.log(`Path: ${m.workspacePath}`);
        console.log(
          `Visible ${m.counts.visible} · transformed ${m.counts.transformed} · blocked ${m.counts.blocked} · local-only ${m.counts.localOnly} · symlinks skipped ${m.counts.symlinksSkipped}`,
        );
      }),
    );
  ws.command("clean [id]")
    .description("Remove one workspace, or all with --all")
    .option("--all", "remove all workspaces", false)
    .action(
      action(async (cmd) => {
        const { g, t } = getContext(cmd);
        const opts = cmd.opts();
        if (opts.all) {
          const n = cleanAllWorkspaces();
          if (g.json) return void printJson({ removed: n });
          return void console.log(t("workspace.cleaned", { count: String(n) }));
        }
        const id = cmd.args[0];
        if (!id) return void console.error(`${symbols.err()} Provide an id or --all.`);
        cleanWorkspace(id);
        if (g.json) return void printJson({ removed: 1 });
        console.log(t("workspace.cleaned", { count: "1" }));
      }),
    );

  // ---- audit ----
  const audit = program.command("audit").description("Local, metadata-only audit log");
  audit
    .command("list")
    .description("List recorded runs")
    .action(
      action(async (cmd) => {
        const { g, t } = getContext(cmd);
        const records = listAudit(50);
        if (g.json) return void printJson(records);
        if (records.length === 0) return void console.log(t("audit.none"));
        console.log(heading("Audit"));
        for (const r of records) {
          console.log(
            `  ${ui.bold(r.id)}  ${ui.dim(r.timestamp)}  ${r.agent}  ${r.outcome}  exit=${r.exitCode ?? "-"}`,
          );
        }
      }),
    );
  audit
    .command("show <id>")
    .description("Show one audit record")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const rec = showAudit(cmd.args[0]!);
        if (g.json) return void printJson(rec);
        printJson(rec);
      }),
    );
  audit
    .command("export <id>")
    .description("Export an audit record")
    .option("--format <fmt>", "json", "json")
    .action(
      action(async (cmd) => {
        getContext(cmd);
        process.stdout.write(exportAudit(cmd.args[0]!, "json") + "\n");
      }),
    );

  // ---- doctor ----
  program
    .command("doctor")
    .description("Check your environment and configuration")
    .action(
      action(async (cmd) => {
        const { g, t, dir } = getContext(cmd);
        const report = await runDoctor(dir);
        if (g.json) return void printJson(report);
        return renderDoctor(report, t);
      }),
    );

  // ---- setup-local-ai ----
  program
    .command("setup-local-ai")
    .description("Set up a local AI model (Ollama) for the Prepare locally route")
    .option("--model <id>", "model to install (default: recommended)")
    .action(
      action(async (cmd) => {
        const { g, dir } = getContext(cmd);
        const opts = cmd.opts();
        const platform = process.platform;

        // Config is optional here — fall back to defaults when absent.
        let settings: Awaited<ReturnType<typeof loadConfig>> | undefined;
        try {
          settings = await loadConfig(dir);
        } catch {
          settings = undefined;
        }
        const localModel = settings?.config.local_model;
        const provider = createLocalModelProvider(providerConfigFromSettings(localModel));

        // 1) Is the ollama binary installed? Never install it ourselves.
        const ollamaPath = lookupOnPath("ollama");
        if (!ollamaPath) {
          if (g.json)
            return void printJson({
              state: "ollama-missing",
              downloadUrl: OLLAMA_DOWNLOAD_URL,
              hint: installHintForPlatform(platform),
            });
          console.log(heading("Set up local AI"));
          console.log(`${symbols.warn()} Ollama is not installed.`);
          console.log(`  Download it from: ${ui.bold(OLLAMA_DOWNLOAD_URL)}`);
          console.log(`  ${ui.dim(installHintForPlatform(platform))}`);
          console.log("\n" + ui.dim("Yuhi will not install anything for you. Re-run this after installing Ollama."));
          return 1;
        }

        // 2) Show installed models + recommended tiers (prefer live sizes).
        const health = await provider.health();
        const installed = health.models ?? [];
        const liveSizes = await fetchInstalledTags(provider.endpoint);
        const recommended = opts.model ?? RECOMMENDED_MODELS[0] ?? DEFAULT_LOCAL_MODEL.model;

        if (g.json)
          return void printJson({
            state: health.ok ? "ready-to-setup" : "ollama-stopped",
            ollamaPath,
            endpoint: provider.endpoint,
            installedModels: installed,
            recommended,
            tiers: MODEL_TIERS,
          });

        console.log(heading("Set up local AI"));
        console.log(`${symbols.ok()} Ollama found: ${ui.dim(ollamaPath)}`);
        if (!health.ok) {
          console.log(`${symbols.warn()} Ollama is installed but not responding at ${provider.endpoint}.`);
          console.log(`  ${ui.dim("Start it with `ollama serve`, then re-run this command.")}`);
          return 1;
        }
        if (installed.length > 0) {
          console.log(ui.dim(`  Installed models: ${installed.join(", ")}`));
        } else {
          console.log(ui.dim("  No models installed yet."));
        }
        console.log("");
        renderModelTiers(MODEL_TIERS, liveSizes, recommended);

        if (isModelInstalled(installed, recommended)) {
          console.log("\n" + `${symbols.ok()} ${recommended} is already installed.`);
          if (settings) await writeModelToConfig(settings.configPath, recommended);
          console.log(ui.dim("Set as the local model in yuhi.yaml." + (settings ? "" : " (No yuhi.yaml — run `yuhi init` to persist.)")));
          return 0;
        }

        // 3) Require EXPLICIT confirmation before any download.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.log(
            "\n" +
              ui.yellow(
                `Run this in an interactive terminal to confirm downloading ${recommended}, or run \`ollama pull ${recommended}\` yourself.`,
              ),
          );
          return 1;
        }
        const tier = MODEL_TIERS.find((m) => m.id === recommended);
        const sizeHint = tier ? ` (${tier.approxSize})` : "";
        const go = await confirm(`Download ${recommended}${sizeHint} now?`, true);
        if (!go) {
          console.log(ui.dim("No download started."));
          return 0;
        }

        // 4) Pull with inherited stdio (native progress); Ctrl-C cancels.
        console.log("\n" + ui.dim(`Running: ollama pull ${recommended}  (press Ctrl-C to cancel)\n`));
        const pull = await pullModel(recommended);
        if (pull.cancelled) {
          console.log("\n" + ui.yellow("Download cancelled. Nothing was written to yuhi.yaml."));
          return 130;
        }
        if (pull.code !== 0) {
          console.log("\n" + `${symbols.err()} ollama pull exited with code ${pull.code ?? "unknown"}.`);
          return 1;
        }

        // 5) Smoke test the freshly installed model, then persist the choice.
        console.log("\n" + ui.dim("Verifying with a tiny local test…"));
        const smoke = await smokeTest(provider, recommended);
        if (!smoke.ok) {
          console.log(`${symbols.warn()} ${smoke.detail}`);
          console.log(ui.dim("The model was installed but the test did not pass. You can still try `yuhi prepare`."));
        } else {
          console.log(`${symbols.ok()} ${smoke.detail}`);
        }
        if (settings) {
          await writeModelToConfig(settings.configPath, recommended);
          console.log(`${symbols.ok()} Set ${ui.bold(recommended)} as the local model in yuhi.yaml.`);
        } else {
          console.log(ui.dim(`Run \`yuhi init\` to persist ${recommended} as your local model in yuhi.yaml.`));
        }
        return 0;
      }),
    );

  // ---- prepare ----
  program
    .command("prepare [dir]")
    .description("Prepare a local, reduced copy of your context (never sent anywhere)")
    .option("--safety-mode <mode>", "balanced | strict | maximum-privacy (default: balanced)")
    .option("--privacy-mode <mode>", "balanced | strict | trusted-local (default: balanced)")
    .option(
      "--acknowledge-unmasked-data",
      "required (non-interactive) to select --privacy-mode trusted-local",
      false,
    )
    .option("--compress", "opt-in v0.3.3 structure compression of the delivered context", false)
    .option("--token-budget <n>", "best-effort token budget for the delivered context")
    .option("--wait-background", "opt-in: run deferred background preparation to completion before returning", false)
    .action(
      action(async (cmd) => {
        const { g, dir } = getContext(cmd);

        const rawSafetyMode = cmd.opts().safetyMode as string | undefined;
        let safetyMode: SafetyMode | undefined;
        if (rawSafetyMode !== undefined) {
          if (!isSafetyMode(rawSafetyMode)) {
            console.error(
              `${symbols.err()} Unknown --safety-mode '${rawSafetyMode}'. Use: balanced, strict, maximum-privacy.`,
            );
            return 3;
          }
          safetyMode = rawSafetyMode;
        }
        const rawPrivacyMode = (cmd.opts().privacyMode as string | undefined) ?? "";

        const compress = Boolean(cmd.opts().compress);
        const rawTokenBudget = cmd.opts().tokenBudget as string | undefined;
        let tokenBudget: number | null = null;
        if (rawTokenBudget !== undefined) {
          const parsed = Number(rawTokenBudget);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            console.error(
              `${symbols.err()} Invalid --token-budget '${rawTokenBudget}'. Use a positive integer.`,
            );
            return 3;
          }
          tokenBudget = parsed;
        }
        if (tokenBudget !== null && !compress) {
          console.error(`${symbols.err()} --token-budget requires --compress.`);
          return 3;
        }

        const target = await assertSafeSourceWorkspace(cmd.args[0] ?? dir);

        const loaded = await loadConfig(target);
        const providerFactory = () => createLocalModelProvider(
          providerConfigFromSettings(loaded.config.local_model),
        );

        // Effective Safety Mode: CLI flag > yuhi.yaml `safetyMode` > balanced.
        // (Previously only the CLI flag was honored, so a `safetyMode:` written in
        //  yuhi.yaml by `yuhi init` was silently ignored.)
        const effectiveSafetyMode = resolveSafetyMode({
          cli: safetyMode,
          repo: loaded.config.safetyMode,
        });
        if (!g.json && effectiveSafetyMode !== "balanced") {
          console.log(`Safety Mode: ${safetyModeLabel(effectiveSafetyMode)}`);
        }

        // Effective Privacy Mode: CLI flag > yuhi.yaml `privacy.mode` > balanced
        // (Section 5 precedence — a DIFFERENT axis from Safety Mode; see
        // packages/shared/src/privacy-mode.ts's module doc comment).
        let acknowledgedTrustedLocal = Boolean(cmd.opts().acknowledgeUnmaskedData);
        // Interactive fallback: `confirm()` returns the default (false) when
        // non-interactive, so this line alone satisfies BOTH "prompt when a human is
        // there" and "fail closed when not" without a separate TTY check — but only
        // ask when the flag wasn't already given and the selection is actually
        // trusted-local, so a plain `yuhi prepare` never prompts.
        const candidateMode = rawPrivacyMode || loaded.config.privacy?.mode || "";
        if (!acknowledgedTrustedLocal && candidateMode === "trusted-local") {
          acknowledgedTrustedLocal = await confirm(
            "Trusted Local delivers personal identifiers unchanged. Continue?",
            false,
          );
        }
        let privacyMode: PrivacyMode;
        try {
          privacyMode = resolvePrivacyPolicy({
            candidates: [
              { mode: rawPrivacyMode, source: "cli" },
              { mode: loaded.config.privacy?.mode ?? "", source: "workspace-config" },
            ],
            trustedLocalAcknowledged: acknowledgedTrustedLocal,
          }).mode;
        } catch (err) {
          if (err instanceof PrivacyModeResolutionError) {
            console.error(`${symbols.err()} ${err.message}`);
            if (err.code === "trusted-local-not-acknowledged") {
              console.error("Re-run with --acknowledge-unmasked-data to proceed non-interactively.");
            } else {
              console.error("Use: balanced, strict, trusted-local.");
            }
            return 3;
          }
          throw err;
        }
        if (!g.json) {
          const copy = privacyModeCopyFor(privacyMode, "static-prepare");
          console.log(`Privacy: ${copy.title}`);
          if (privacyMode === "trusted-local") {
            for (const line of copy.en.split("\n")) if (line) console.log(line);
          }
        }

        const mode = loaded.config.budget?.reduction_mode;
        const res = await prepareWorkspace(target, {
          providerFactory,
          ...(mode !== undefined ? { mode } : {}),
          safetyMode: effectiveSafetyMode,
          privacyMode,
          compress,
          ...(tokenBudget !== null ? { tokenBudget } : {}),
        });
        await writePreparedRunSession(res);

        // Opt-in: wait for deferred background preparation to finish before
        // returning. Default `yuhi prepare` is unchanged (enqueue only, no wait).
        await maybeWaitBackground({
          wait: Boolean(cmd.opts().waitBackground),
          runId: res.runId,
          preparedDir: res.outDir,
          run: ({ runId, preparedDir, signal }) =>
            runBackgroundForRun({
              runId,
              preparedDir,
              config: loaded.config,
              providerFactory,
              ...(signal ? { signal } : {}),
            }),
        });

        let result = buildCliPrepareResult(res);
        // #16: with --wait-background the background pass has already refreshed
        // `.yuhi/yuhi-mode-summary.json` on disk, but `res` was captured BEFORE it
        // ran — so printing straight from `res` reported "Background status: running"
        // and a plain "ready" for a document that had in fact finished with no
        // context at all. Re-read the refreshed summary and render that instead of
        // recomputing anything here.
        if (cmd.opts().waitBackground) {
          const refreshed = await readRefreshedYuhiModeSummary(res.outDir);
          if (refreshed) result = { ...result, yuhiModeSummary: refreshed };
        }
        if (g.json) printJson(result);
        else if (result.status === "Success") {
          // Blue "Yuhi Mode" banner mirroring the VS Code accent; file-level
          // exclusions never downgrade a launchable workspace.
          // #12: "excluded by recommendation" may ONLY count files actually withheld
          // from the agent-visible tree. It used to add
          // `unsupportedOrUnverifiedFiles`, which are DELIVERED (often as raw
          // originals) — so the banner claimed a file had been withheld for the
          // user's protection at the moment the sensitive one was shipped whole.
          const excluded =
            result.deliveryIntegrity?.excludedByRecommendation ?? result.filesKeptLocal;
          const warned = result.deliveryIntegrity?.deliveredWithWarning ?? 0;
          const parts = [`${result.filesIncluded} files available`];
          if (excluded > 0) parts.push(`${excluded} excluded by recommendation`);
          if (warned > 0) parts.push(`${warned} delivered with a warning`);
          const detail = parts.join(" · ");
          console.log(yuhiBanner(result.launchAllowed ? "ready" : "partial", detail) + "\n");
          console.log(formatCliPrepareResult(result));
          // v0.3.3: when compression ran, follow the summary with the compression block.
          // With --json the same data is already inside the JSON result (nothing extra).
          if (res.compression) {
            console.log("\n" + formatCompressionReport(res.compression, "terminal"));
          }
        } else {
          console.error(yuhiBanner("partial") + "\n");
          console.error(formatCliPrepareResult(result));
        }
        return cliPrepareExitCode(result);
      }),
    );

  // ---- report ----  the shareable, public-safe proof-of-value artifact
  program
    .command("report <run>")
    .description("Print the shareable Yuhi Repository Report (public-safe: numbers only)")
    .option("--format <format>", "terminal | markdown | json | svg", "terminal")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const format = String(cmd.opts().format ?? "terminal");
        const allowed = ["terminal", "markdown", "json", "svg"] as const;
        if (!(allowed as readonly string[]).includes(format)) {
          console.error(`${symbols.err()} Unknown --format '${format}'. Use: ${allowed.join(", ")}.`);
          return 3;
        }
        try {
          const { session } = await readPreparedRunSession(cmd.args[0]!);
          const report = session.summary.preparationReport;
          if (g.json && format === "terminal") return void printJson(report);
          process.stdout.write(
            formatPreparationReport(report, format as "terminal" | "markdown" | "json" | "svg") + "\n",
          );
          return 0;
        } catch {
          console.error("Recovery required\n\nSafe error category: invalid-or-missing-run");
          return 3;
        }
      }),
    );

  // ---- report-compression ----  the v0.3.3 Context Compression summary for a run
  program
    .command("report-compression <run>")
    .description("Show the v0.3.3 Context Compression summary for a prepared run")
    .option("--format <format>", "terminal | json", "terminal")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const format = String(cmd.opts().format ?? "terminal");
        if (format !== "terminal" && format !== "json") {
          console.error(`${symbols.err()} Unknown --format '${format}'. Use: terminal, json.`);
          return 3;
        }
        try {
          const { session } = await readPreparedRunSession(cmd.args[0]!);
          const compression = session.summary.compression;
          if (!compression) {
            if (g.json) printJson({ command: "report-compression", compression: null });
            else console.log("This run was prepared without --compress.");
            return 0;
          }
          if (g.json) return void printJson(compression);
          process.stdout.write(formatCompressionReport(compression, format) + "\n");
          return 0;
        } catch {
          console.error("Recovery required\n\nSafe error category: invalid-or-missing-run");
          return 3;
        }
      }),
    );

  program
    .command("review <run>")
    .description("Review metadata for a Prepared Workspace without exposing source data")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        try {
          const { session } = await readPreparedRunSession(cmd.args[0]!);
          if (g.json) printJson({ command: "review", ...session.summary });
          else {
            const text = formatCliPrepareResult(session.summary);
            if (session.summary.status === "Success") console.log(text);
            else console.error(text);
          }
          return cliPrepareExitCode(session.summary);
        } catch {
          console.error("Recovery required\n\nSafe error category: invalid-or-missing-run");
          return 3;
        }
      }),
    );

  program
    .command("review-agent-changes <run>")
    .description("Review post-agent Prepared Workspace changes; never applies automatically")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        return patchStatus({ runRef: cmd.args[0]!, json: g.json });
      }),
    );

  program
    .command("open <run> [agent]")
    .description("Temporarily disabled in the 0.2.2 early preview")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const result = {
          schemaVersion: 1,
          command: "open",
          status: "Disabled",
          launchAllowed: false,
          agentStarted: false,
          safeErrorCategory: "cli-agent-launch-disabled",
        };
        if (g.json) printJson(result);
        else {
          console.error(
            "CLI agent launch is temporarily disabled in the 0.2.2 early preview.\n\n" +
            "Use the Yuhi VS Code preparation and Claude Code handoff workflow.",
          );
        }
        return 4;
      }),
    );

  program
    .command("prepare-again <run>")
    .description("Create a new run while explicitly excluding files blocked in an old run")
    .requiredOption("--source <dir>", "original source folder (never read from persisted metadata)")
    .option("--exclude-blocked", "explicitly exclude blocked/error files", false)
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts() as { source: string; excludeBlocked: boolean };
        if (!opts.excludeBlocked) {
          console.error("Invalid input\n\nUse --exclude-blocked to explicitly confirm exclusion.");
          return 3;
        }
        let oldWorkspace: string;
        try {
          oldWorkspace = resolvePreparedRunReference(cmd.args[0]!);
          await readPreparedRunSession(cmd.args[0]!);
        } catch {
          console.error("Recovery required\n\nSafe error category: invalid-or-missing-run");
          return 3;
        }
        const manifest = JSON.parse(
          await readFile(`${oldWorkspace}/manifest.json`, "utf8"),
        ) as { files?: { relpath?: unknown; status?: unknown }[] };
        const excluded = (manifest.files ?? [])
          .filter((file) => file.status === "error" || file.status === "blocked")
          .map((file) => file.relpath)
          .filter((value): value is string => typeof value === "string");
        if (excluded.length === 0) {
          console.error("Invalid input\n\nSafe error category: no-blocked-files");
          return 3;
        }
        const source = await assertSafeSourceWorkspace(opts.source);
        const loaded = await loadConfig(source);
        const providerFactory = () => createLocalModelProvider(
          providerConfigFromSettings(loaded.config.local_model),
        );
        const report = await prepareWorkspace(source, {
          providerFactory,
          excludeRelpaths: excluded,
          safetyMode: resolveSafetyMode({ repo: loaded.config.safetyMode }),
          ...(loaded.config.budget?.reduction_mode
            ? { mode: loaded.config.budget.reduction_mode }
            : {}),
        });
        await writePreparedRunSession(report);
        const result = buildCliPrepareResult(report);
        if (g.json) printJson({ command: "prepare-again", ...result });
        else if (result.status === "Success") console.log(formatCliPrepareResult(result));
        else console.error(formatCliPrepareResult(result));
        return cliPrepareExitCode(result);
      }),
    );

  // ---- agents ----
  program
    .command("agents")
    .description("List known agents and whether they are installed")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const rows = await Promise.all(
          ["dummy", ...KNOWN_AGENT_IDS].map(async (id) => {
            const a = buildAdapter(id);
            return { id, displayName: a.displayName, installed: await a.detect() };
          }),
        );
        if (g.json) return void printJson(rows);
        console.log(heading("Agents"));
        for (const r of rows) {
          const mark = r.installed ? symbols.ok() : symbols.warn();
          console.log(`  ${mark} ${r.id.padEnd(8)} ${ui.dim(r.displayName)}`);
        }
      }),
    );

  // ---- launch ----  personal-first: run an installed agent on a prepared run
  const launch = program
    .command("launch")
    .description("Launch an installed agent (claude | codex) on a prepared run");
  for (const spec of [
    { id: "claude", display: "Claude Code" },
    { id: "codex", display: "OpenAI Codex CLI" },
  ] as const) {
    launch
      .command(spec.id)
      .description(`Launch ${spec.display} on a prepared run`)
      .option("--run <id>", "prepared run id (default: the latest completed run)")
      .option("--dry-run", "prepare + print the Ready summary but do not launch", false)
      .option(
        "--dynamic-context",
        "route the agent through the local Yuhi gateway so tool results are compressed live (claude only)",
        false,
      )
      .option(
        "--delivery-mode <mode>",
        "how detected secrets are handled: developer (default, project configuration reaches the agent) | strict (mask before delivery, 0.3.x behaviour)",
        "developer",
      )
      .option(
        "--retrieval <mode>",
        "retrieval capability shown to the agent: disabled | conditional | required (measured: registering the tools costs agent turns)",
        "disabled",
      )
      .action(
        action(async (cmd) => {
          const { g } = getContext(cmd);
          const opts = cmd.opts();
          if (opts.dynamicContext) {
            if (spec.id !== "claude") {
              console.error("--dynamic-context currently supports claude only.\n\nSafe error category: unsupported-agent");
              return 3;
            }
            const { launchClaudeWithDynamicContext } = await import("./dynamic-context/launch-dynamic.js");
            const result = await launchClaudeWithDynamicContext({
              ...(opts.run ? { runRef: String(opts.run) } : {}),
              forwardedArgs: forwarded,
              spawn: !opts.dryRun,
              json: g.json,
              cliEntry: process.argv[1] ?? "",
              deliveryMode: opts.deliveryMode === "strict" ? "strict" : "developer",
              retrieval: (["disabled", "conditional", "required"] as const).includes(opts.retrieval)
                ? (opts.retrieval as "disabled" | "conditional" | "required")
                : "disabled",
            });
            return result.exitCode;
          }
          return await performLaunch({
            agentId: spec.id,
            ...(opts.run ? { runRef: String(opts.run) } : {}),
            forwardedArgs: forwarded,
            spawn: !opts.dryRun,
            json: g.json,
            verbose: g.verbose,
          });
        }),
      );
  }

  // ---- dynamic ----  v0.4.0 Repository Virtualization Runtime
  const dynamicCommand = program
    .command("dynamic")
    .description("Dynamic context runtime: health checks and measured statistics");

  dynamicCommand
    .command("doctor")
    .description("Check everything the dynamic context runtime needs")
    .option("--offline", "skip the upstream reachability probe", false)
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        const { runDynamicDoctor, formatDoctorReport, doctorExitCode } = await import(
          "./dynamic-context/doctor.js"
        );
        const checks = await runDynamicDoctor({ offline: Boolean(opts.offline) });
        if (g.json) printJson({ command: "dynamic doctor", checks });
        else console.log(formatDoctorReport(checks));
        return doctorExitCode(checks);
      }),
    );

  dynamicCommand
    .command("stats")
    .description("Show measured dynamic-context statistics for prepared runs")
    .option("--run <id>", "prepared run id (default: the latest completed run)")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        const { resolveRunForLaunch } = await import("./launch.js");
        const { readPersistedStats, formatSnapshot } = await import("./dynamic-context/stats.js");
        const resolution = await resolveRunForLaunch(opts.run ? String(opts.run) : undefined);
        if (!resolution.ok) {
          console.error(`No prepared run found (${resolution.category}).`);
          return 3;
        }
        const root = pathJoin(resolution.run.workspace, ".yuhi", "context");
        const snapshots = await readPersistedStats(root).catch(() => []);
        if (g.json) return void printJson({ command: "dynamic stats", sessions: snapshots });
        if (snapshots.length === 0) {
          console.log("No dynamic-context activity recorded for this run yet.");
          console.log("Start one with: yuhi launch claude --dynamic-context");
          return 0;
        }
        for (const snapshot of snapshots) console.log(formatSnapshot(snapshot).join("\n"));
        console.log("");
        console.log("Dynamic tool-output reduction is an estimate of withheld tool output —");
        console.log("never a provider token measurement, API saving, or billing figure.");
        return 0;
      }),
    );

  // Native GUI Mode session management. The broker owns these sessions, so the CLI reads
  // and repairs them from disk rather than assuming it started them.
  dynamicCommand
    .command("sessions")
    .description("List Native Claude GUI sessions and their health")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const { discoverSessions, describeDiscovered } = await import("@yuhi/context-gateway");
        const sessions = await discoverSessions();
        if (g.json) {
          return void printJson({
            command: "dynamic sessions",
            sessions: sessions.map((s) => ({ sessionId: s.sessionId, health: s.health, state: s.record?.state ?? null })),
          });
        }
        if (sessions.length === 0) {
          console.log("No Native Claude GUI sessions found.");
          return 0;
        }
        for (const session of sessions) console.log(describeDiscovered(session));
        return 0;
      }),
    );

  dynamicCommand
    .command("stop")
    .description("Stop a Native Claude GUI session and its gateway")
    .argument("<session-id>")
    .action(
      action(async (cmd) => {
        const sessionId = String(cmd.args[0] ?? "");
        const { cleanupSession, sessionLayout } = await import("@yuhi/context-gateway");
        const result = await cleanupSession(sessionLayout(sessionId), {});
        if (!result.ok) {
          const failed = result.steps.filter((s) => !s.ok).map((s) => s.step);
          console.error(`Stopped with problems: ${failed.join(", ")}`);
          return 3;
        }
        console.log(`Stopped ${sessionId}.`);
        return 0;
      }),
    );

  dynamicCommand
    .command("recover")
    .description("Finish the shutdown of stale Native Claude GUI sessions")
    .option("--purge-finished", "also delete the directories of sessions that already closed")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        const { recoverStaleSessions } = await import("@yuhi/context-gateway");
        const result = await recoverStaleSessions({ purgeFinished: Boolean(opts.purgeFinished) });
        if (g.json) return void printJson({ command: "dynamic recover", ...result });
        console.log(
          `Inspected ${result.inspected}; recovered ${result.recovered.length}; still running ${result.skippedLive.length}; failed ${result.failed.length}.`,
        );
        return result.failed.length > 0 ? 3 : 0;
      }),
    );


  // ---- mcp ----  retrieval server started by Claude Code, not by the user
  program
    .command("mcp")
    .description("Model Context Protocol servers")
    .command("serve")
    .description("Serve Yuhi retrieval tools over stdio (started by the agent)")
    .action(
      action(async () => {
        const { configFromEnv, runStdioServer } = await import("@yuhi/context-mcp");
        const config = configFromEnv(process.env);
        if (!config) {
          console.error("YUHI_CONTEXT_ROOT and YUHI_SESSION_ID must be set. This server is started by Yuhi.");
          return 3;
        }
        await runStdioServer({ ...config, version: cliVersion() });
        return 0;
      }),
    );

  // ---- patch ----  v0.3.6 Safe Patch Review
  const patchCommand = program
    .command("patch")
    .description("Review first. Apply selected agent changes safely.");
  patchCommand
    .command("status")
    .option("--run <id>", "prepared run id (default: latest)")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      const opts = cmd.opts();
      return patchStatus({ ...(opts.run ? { runRef: String(opts.run) } : {}), json: g.json });
    }));
  patchCommand
    .command("diff")
    .option("--run <id>", "prepared run id (default: latest)")
    .option("--file <relpath>", "show one repository-relative file")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      const opts = cmd.opts();
      return patchDiff({
        ...(opts.run ? { runRef: String(opts.run) } : {}),
        ...(opts.file ? { files: [String(opts.file)] } : {}),
        json: g.json,
      });
    }));
  patchCommand
    .command("validate")
    .option("--run <id>", "prepared run id (default: latest)")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      const opts = cmd.opts();
      return patchValidate({ ...(opts.run ? { runRef: String(opts.run) } : {}), json: g.json });
    }));
  patchCommand
    .command("apply")
    .option("--run <id>", "prepared run id (default: latest)")
    .option("--file <relpath...>", "apply only selected repository-relative files")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      const opts = cmd.opts();
      return patchApply({
        ...(opts.run ? { runRef: String(opts.run) } : {}),
        ...(Array.isArray(opts.file) ? { files: opts.file.map(String) } : {}),
        json: g.json,
        confirmApply: (count) => confirm(`Apply ${count} reviewed change(s) to the Original Workspace?`, false),
      });
    }));
  patchCommand
    .command("undo <patch-id>")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      return patchUndoCommand({ patchId: cmd.args[0]!, json: g.json });
    }));
  patchCommand
    .command("history")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      return patchHistoryCommand({ json: g.json });
    }));
  patchCommand
    .command("discard")
    .option("--run <id>", "prepared run id (default: latest)")
    .action(action(async (cmd) => {
      const { g } = getContext(cmd);
      const opts = cmd.opts();
      return patchDiscard({ ...(opts.run ? { runRef: String(opts.run) } : {}), json: g.json });
    }));

  // ---- background ----  v0.3.5 Progressive Context control surface
  const background = program
    .command("background")
    .description("Observe and steer deferred background preparation for a prepared run");
  background
    .command("status")
    .description("Show background preparation status from the public status file")
    .option("--run <id>", "prepared run id (default: the latest completed run)")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        return await performBackgroundStatus({
          ...(opts.run ? { runRef: String(opts.run) } : {}),
          json: g.json,
        });
      }),
    );
  background
    .command("start")
    .description("Run deferred background preparation to completion (cancellable with Ctrl-C)")
    .option("--run <id>", "prepared run id (default: the latest completed run)")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        return await performBackgroundStart({
          ...(opts.run ? { runRef: String(opts.run) } : {}),
          json: g.json,
        });
      }),
    );
  background
    .command("cancel")
    .description("Cancel the whole run, or a single item with --item")
    .option("--run <id>", "prepared run id (default: the latest completed run)")
    .option("--item <itemId>", "cancel only this item")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        return await performBackgroundCancel({
          ...(opts.run ? { runRef: String(opts.run) } : {}),
          ...(opts.item ? { itemId: String(opts.item) } : {}),
          json: g.json,
        });
      }),
    );
  background
    .command("retry")
    .description("Re-queue terminal items (never completed ones)")
    .option("--run <id>", "prepared run id (default: the latest completed run)")
    .option("--item <itemId>", "retry only this item")
    .option("--failed-only", "restrict a bulk retry to failed / timed-out items", false)
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts();
        return await performBackgroundRetry({
          ...(opts.run ? { runRef: String(opts.run) } : {}),
          ...(opts.item ? { itemId: String(opts.item) } : {}),
          failedOnly: Boolean(opts.failedOnly),
          json: g.json,
        });
      }),
    );

  await program.parseAsync(mainArgv);
}

function notFound(t: Translator, path: string): YuhiError {
  return new YuhiError("INTERNAL", t("explain.notFound", { path }), {
    hint: "Run `yuhi scan` to see which files Yuhi inspected.",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
