import { Command } from "commander";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
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
  reviewAgentChanges,
  deriveWorkflowState,
  formatPreparationReport,
  isSafetyMode,
  safetyModeLabel,
  type SafetyMode,
  type AgentChangeBaseline,
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
  const { main: mainArgv } = splitForwarded(process.argv);

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

        const mode = loaded.config.budget?.reduction_mode;
        const res = await prepareWorkspace(target, {
          providerFactory,
          ...(mode !== undefined ? { mode } : {}),
          safetyMode: effectiveSafetyMode,
        });
        await writePreparedRunSession(res);

        const result = buildCliPrepareResult(res);
        if (g.json) printJson(result);
        else if (result.status === "Success") {
          // Blue "Yuhi Mode" banner mirroring the VS Code accent; file-level
          // exclusions never downgrade a launchable workspace.
          const excluded = result.filesKeptLocal + result.unsupportedOrUnverifiedFiles;
          const detail =
            excluded > 0
              ? `${result.filesIncluded} files available · ${excluded} excluded by recommendation`
              : `${result.filesIncluded} files available`;
          console.log(yuhiBanner(result.launchAllowed ? "ready" : "partial", detail) + "\n");
          console.log(formatCliPrepareResult(result));
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
    .requiredOption("--original <dir>", "original workspace used for conflict checks")
    .requiredOption("--baseline <file>", "metadata-only baseline captured before agent execution")
    .action(
      action(async (cmd) => {
        const { g } = getContext(cmd);
        const opts = cmd.opts() as { original: string; baseline: string };
        const prepared = resolvePreparedRunReference(cmd.args[0]!);
        await readPreparedRunSession(cmd.args[0]!);
        const original = await assertSafeSourceWorkspace(opts.original);
        const baseline = JSON.parse(await readFile(path.resolve(opts.baseline), "utf8")) as AgentChangeBaseline;
        if (
          baseline?.schemaVersion !== 2 ||
          typeof baseline.runId !== "string" ||
          !Array.isArray(baseline.files)
        ) {
          console.error("Invalid input\n\nSafe error category: invalid-agent-baseline");
          return 3;
        }
        const review = await reviewAgentChanges(baseline, prepared, original);
        const output = {
          command: "review-agent-changes",
          runId: baseline.runId,
          changedFileCount: review.changes.length,
          changes: review.changes,
          security: review.security,
          applyAllowed: review.applyAllowed,
          blockers: review.blockers,
          applyResult: "unavailable-in-cli",
          workflowState: deriveWorkflowState({
            changedFileCount: review.changes.length,
            reviewingChanges: true,
          }),
        };
        if (g.json) printJson(output);
        else {
          console.log(`AI Agent completed\n\nChanges detected: ${output.changedFileCount}`);
          console.log(`Security scan: ${output.security.safe ? "Passed" : "Blocked"}`);
          console.log(`Apply: ${output.applyResult}`);
          if (output.blockers.length > 0) console.log(`Blockers: ${output.blockers.join(", ")}`);
        }
        return 0;
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
