import { spawn } from "node:child_process";
import type {
  Reporter,
  TestCase,
  TestResult,
  TestStep,
  FullConfig,
  Suite,
  FullResult,
} from "@playwright/test/reporter";

/**
 * ObservoReporter — Playwright reporter that streams test lifecycle to
 * an Observo dashboard by shelling out to the `observo` CLI.
 *
 * Architecture (per OB-341 / OB-346): the CLI is the single ingestion
 * channel; the reporter does NOT duplicate run-creation, auth, or
 * upload contract. It subscribes to Playwright Reporter API events and
 * invokes one primitive CLI subcommand per event:
 *
 *   onBegin       → observo run create        (if no existing run env)
 *   onTestBegin   → observo run case set --status in_progress
 *   onStepEnd     → observo run case step set
 *   onAttachment* → observo run attach
 *   onTestEnd     → observo run case set with final status
 *   onEnd         → observo run finish        (only if reporter created the run)
 *
 * *Attachments fire from inside onTestEnd because that's when Playwright
 * has finalised result.attachments[] — there is no separate onAttachment
 * hook on the Reporter interface today.
 *
 * Configuration is read from env vars, mirroring the observo CLI's own
 * convention. Required:
 *   - OBSERVO_API_KEY     account-scoped API key
 *
 * Recommended:
 *   - OBSERVO_PROJECT_CODE   project UUID or short code (`MYAPP`). Matches
 *                            the CLI's own env name. OBSERVO_PROJECT is
 *                            accepted as a legacy fallback.
 *   - OBSERVO_BASE_URL    default https://api.observoai.co
 *
 * Optional:
 *   - OBSERVO_RUN_KEY     attach to an existing run instead of creating one;
 *                         the reporter then SKIPS onBegin/onEnd run lifecycle.
 *                         Can also be passed as the `runKey` reporter option
 *                         (option wins when both are set — see ReporterOptions).
 *   - OBSERVO_CLI_PATH    path to `observo` binary (default: from PATH)
 *
 * Activation: reporter no-ops entirely (zero CLI calls) unless
 * OBSERVO_API_KEY is set. Local `npx playwright test` runs without
 * the env never trigger uploads or warnings.
 */

interface ReporterOptions {
  /**
   * Attach to an existing Observo run instead of creating one in
   * `onBegin`. Takes precedence over the OBSERVO_RUN_KEY env var when
   * both are set. When supplied (from either source), the reporter
   * SKIPS `observo run create` in onBegin and `observo run finish` in
   * onEnd — the orchestrator that pre-created the run owns its
   * lifecycle.
   *
   * Passing this as an explicit option is preferred over the env var
   * when wiring the reporter from a CI workflow that already plumbs
   * the run id through Playwright config: it makes the "attach to
   * existing run" intent visible at the config call site instead of
   * relying on opaque env-to-config plumbing.
   *
   * Accepts either the run short key (e.g. `RUN-42`) or the run UUID.
   */
  runKey?: string;
  /**
   * Override the plan key used for `observo run create` when the
   * reporter creates the run itself (OBSERVO_RUN_KEY unset). Defaults
   * to the value of OBSERVO_PLAN env var. When neither is set, no
   * --plan flag is passed and the CLI creates a plan-less run.
   */
  plan?: string;
  /**
   * Upload attachments on passed cases too. Defaults to false to keep
   * dashboard storage bounded on green runs.
   */
  uploadPassed?: boolean;
  /**
   * Emit a `pipeline.layers[]` aggregate in `onEnd` so `observo run
   * finish --status auto` (called by the orchestrator) can see the
   * Playwright pass/fail outcome alongside the other CI layers. Pass
   * `false` to disable entirely; pass an object to override the
   * defaults below.
   *
   * The aggregate is sourced from the JUnit reporter's `outputFile`
   * — Playwright already produces the XML when the `junit` reporter
   * is configured (recommended for CI). When no `junit` reporter is
   * found in the Playwright config and `junitPath` is not supplied,
   * the emission is skipped with a one-line warning; per-case
   * PATCHes continue to work and are unaffected.
   *
   * Defaults:
   *   layerId      = "e2e"
   *   displayName  = "E2E (Playwright)"
   *   framework    = "playwright"
   *   junitPath    = auto-detected from FullConfig.reporter[]
   */
  pipelineLayer?:
    | false
    | {
        layerId?: string;
        displayName?: string;
        framework?: string;
        junitPath?: string;
      };
}

interface ResolvedConfig {
  apiKey: string;
  project: string;
  baseUrl: string;
  runKey: string; // empty when reporter must create the run
  cliPath: string;
  plan: string;
  uploadPassed: boolean;
}

// Mirrors observo-cli's TAG_RE for `@observo:CODE-N` annotations.
// The CODE prefix is open-ended (per spec it's the customer's project
// short code, e.g. WEB / MYAPP / CHECKOUT). Anything matching the
// `[A-Z]+-\d+` shape after `@observo:` is treated as the case short code.
const TAG_RE = /^@observo:([A-Z]+-\d+)$/;

// Fallback resolver: scan the test title and parent suite chain for a
// bare `CODE-N` token when no `@observo:CODE-N` tag is present.
const CODE_IN_TEXT_RE = /\b[A-Z]+-\d+\b/;

function resolveConfig(opts: ReporterOptions): ResolvedConfig | null {
  const apiKey = process.env.OBSERVO_API_KEY || "";
  if (!apiKey) return null; // hard activation gate
  return {
    apiKey,
    // OBSERVO_PROJECT_CODE is the canonical env name the observo CLI
    // itself documents; OBSERVO_PROJECT is the original name this
    // reporter shipped with in v0.1.x. Read both, prefer the CLI's
    // canonical one so a CI workflow that follows the CLI docs Just
    // Works without an extra reporter-specific env (OB-372).
    project:
      process.env.OBSERVO_PROJECT_CODE || process.env.OBSERVO_PROJECT || "",
    baseUrl: process.env.OBSERVO_BASE_URL || "",
    // Option > env: an explicit `runKey` in playwright.config.ts is
    // self-documenting and survives env churn (renames, missing exports).
    // Env stays as the documented fallback so legacy wiring keeps
    // working without a config change.
    runKey: opts.runKey || process.env.OBSERVO_RUN_KEY || "",
    cliPath: process.env.OBSERVO_CLI_PATH || "observo",
    plan: opts.plan || process.env.OBSERVO_PLAN || "",
    uploadPassed: !!opts.uploadPassed,
  };
}

/**
 * OB-405: per-example parameter values for a parametrized test, conveyed via
 * a Playwright TestCase annotation: `{ type: "observo-cells", description: <JSON> }`.
 * The reporter forwards these to the CLI as `--example-cells '<json>'`, which
 * the server then matches against `test_run_cases.param_values` (OB-423) to
 * route the per-step write to the correct example. Use the `observoCells()`
 * helper exported from the package root to construct the annotation in test
 * code without typing the type string and JSON yourself.
 *
 * If multiple `observo-cells` annotations are present, the LAST one wins —
 * matches the natural override pattern of late `test.info().annotations.push(...)`.
 * If the description is missing or not a flat JSON object of string values, it
 * is silently skipped (the per-step write then falls through to the
 * row-number / classic path on the server, and the reporter logs once).
 */
const OBSERVO_CELLS_TYPE = "observo-cells";

export function extractExampleCells(
  test: TestCase,
  warn: (msg: string) => void,
): Record<string, string> | null {
  let chosen: { type: string; description?: string } | null = null;
  // `?? []` — defensive against mocks/edge cases where annotations is unset.
  // Real Playwright always supplies an array per the TestCase API.
  for (const a of test.annotations ?? []) {
    if (a.type === OBSERVO_CELLS_TYPE) chosen = a;
  }
  if (!chosen) return null;
  const desc = (chosen.description ?? "").trim();
  if (!desc) {
    warn(`${test.title}: observo-cells annotation has no description, skipped`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(desc);
  } catch (e) {
    warn(`${test.title}: observo-cells JSON parse failed: ${(e as Error).message}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`${test.title}: observo-cells must be a flat JSON object, skipped`);
    return null;
  }
  const cells: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      warn(`${test.title}: observo-cells value for ${k} is not a string, skipped`);
      return null;
    }
    cells[k] = v;
  }
  if (Object.keys(cells).length === 0) {
    warn(`${test.title}: observo-cells is empty, skipped`);
    return null;
  }
  return cells;
}

function extractShortCode(test: TestCase): string | null {
  // 1. Explicit @observo:CODE-N tag — authoritative.
  for (const tag of test.tags) {
    const m = TAG_RE.exec(tag.trim());
    if (m) return m[1];
  }
  // 2. CODE-N inside the spec title or any parent describe title.
  //    Innermost first per OB-347 R6 fix: nested describes should never
  //    let an OUTER code capture an INNER test (e.g. `describe("WEB-3",
  //    () => test("WEB-7 …"))` resolves to WEB-7, not WEB-3).
  const titles: string[] = [test.title];
  for (let s: Suite | undefined = test.parent; s; s = s.parent) {
    if (s.title) titles.push(s.title);
  }
  for (const t of titles) {
    const m = t.match(CODE_IN_TEXT_RE);
    if (m) return m[0];
  }
  return null;
}

// Playwright TestResult.status maps to Observo case status (per the
// monorepo's existing observo-reporter.ts — preserve those semantics):
//   passed       → passed
//   failed       → failed
//   skipped      → skipped
//   timedOut     → blocked (infra-level, not an assertion failure)
//   interrupted  → blocked (worker terminated / suite-level skip)
function mapStatus(pw: string): string {
  switch (pw) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "timedOut":
    case "interrupted":
      return "blocked";
    default:
      return "blocked";
  }
}

/**
 * Filter to top-level `test.step` nodes only — the same rule the
 * monorepo's e2e/reporters/observo-reporter.ts enforces.
 *
 * Nested `test.step()` calls inside other step callbacks are
 * intentionally NOT flattened: server step numbering follows the
 * test-case definition (flat 1-based list in Observo); flattening
 * Playwright's tree would offset indices and PATCH the wrong step.
 * Operators with nested steps see a warning in CI logs telling them
 * to flatten in test code if they want per-sub-step dashboard signal.
 */
function userSteps(steps: readonly TestStep[]): TestStep[] {
  return steps.filter((s) => s.category === "test.step");
}

/**
 * Locate the JUnit reporter's outputFile in Playwright's FullConfig so
 * the reporter can hand it to `observo run pipeline-layer set` in
 * onEnd. The CLI parses JUnit XML for total/passed/failed/duration_ms
 * — there's no direct numeric-flag mode today (v0.7.x) — so this is
 * the only path to emit a layer aggregate from the reporter.
 *
 * Returns `null` when no `junit` reporter is configured OR when it's
 * configured without an `outputFile` (junit-to-stdout has no file to
 * upload). Caller logs a single warning in that case and skips the
 * layer emission; per-case writeback is unaffected.
 */
function findJunitOutput(config: FullConfig): string | null {
  // Playwright's ReporterDescription is `string | readonly [name, opts?]`
  // — accept both shapes defensively (older Playwright versions may
  // expose the array form even for one-arg reporters).
  const reporters = (config as { reporter?: unknown }).reporter;
  if (!Array.isArray(reporters)) return null;
  for (const entry of reporters) {
    let name: string | undefined;
    let opts: { outputFile?: string } | undefined;
    if (typeof entry === "string") {
      name = entry;
    } else if (Array.isArray(entry)) {
      name = entry[0] as string | undefined;
      opts = entry[1] as { outputFile?: string } | undefined;
    }
    if (name === "junit" && opts?.outputFile) {
      return String(opts.outputFile);
    }
  }
  return null;
}

class ObservoReporter implements Reporter {
  private opts: ReporterOptions;
  private cfg: ResolvedConfig | null = null;
  private runKey: string = ""; // resolved at onBegin (either env or created)
  private createdRun: boolean = false; // tracks whether we owe an onEnd finish
  private fullConfig: FullConfig | null = null; // stashed in onBegin for onEnd's pipeline-layer junit lookup
  // OB-373 finding #3: cases that already emitted a benign "step number
  // N not found" 404 once. Playwright specs frequently emit more
  // `test.step()` calls than the Observo case has step rows — the
  // over-count steps hit a 404 per step, which spams CI logs without
  // adding signal. We surface ONE info-level line per case and stay
  // silent for subsequent occurrences within the same test run.
  private stepNotFoundWarnedFor: Set<string> = new Set();
  // OB-434: every fire-and-forget child registers a promise that resolves
  // when the child closes (success or failure). onEnd awaits this list
  // before returning so the parent process doesn't exit mid-upload and
  // SIGTERM the children — which silently drops trace.zip / video /
  // screenshot attachments for failing cases (the very artifacts the
  // dashboard most needs).
  private pendingChildren: Promise<void>[] = [];
  // Hard cap on how long onEnd waits for in-flight uploads to drain.
  // Belt-and-braces so a wedged S3 PUT can't hang the CI job — the CLI
  // already retries 5xx/429/408 internally, so 60s comfortably covers
  // a typical trace.zip stream + retry budget.
  private static readonly DRAIN_DEADLINE_MS = 60_000;

  constructor(opts: ReporterOptions = {}) {
    this.opts = opts;
  }

  async onBegin(config: FullConfig, _suite: Suite): Promise<void> {
    this.fullConfig = config;
    this.cfg = resolveConfig(this.opts);
    if (!this.cfg) {
      // Silent no-op — user didn't ask for Observo integration.
      return;
    }
    if (this.cfg.runKey) {
      // CI orchestrator (or a prior step) already created a run; just
      // attach to it. We never call `run finish` in this mode — the
      // orchestrator owns the lifecycle.
      this.runKey = this.cfg.runKey;
      this.warn(`live updates → run ${this.runKey}`);
      return;
    }
    // Otherwise create the run ourselves. Capture CI metadata where
    // available so the dashboard shows the right commit / branch / PR
    // alongside the run.
    const args = [
      "run",
      "create",
      "--json",
    ];
    // --project is added by commonArgs() — kept centralized so every
    // subcommand (notably `run case step set`, which requires it)
    // sees it consistently.
    if (this.cfg.plan) args.push("--plan", this.cfg.plan);
    const commit = process.env.GITHUB_SHA;
    if (commit) args.push("--commit", commit);
    const branch = process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_BRANCH;
    if (branch) args.push("--branch", branch);
    const actor = process.env.GITHUB_ACTOR || process.env.GITLAB_USER_LOGIN;
    if (actor) args.push("--actor", actor);

    try {
      const out = await this.runCli(args, { captureStdout: true });
      const parsed = JSON.parse(out || "{}");
      const key = parsed.run_key || parsed.runKey || parsed.run_id || parsed.id;
      if (!key) {
        this.warn(`run create returned no run_key; reporter will no-op`);
        this.cfg = null;
        return;
      }
      this.runKey = String(key);
      this.createdRun = true;
      this.warn(`created run ${this.runKey}`);
    } catch (err) {
      this.warn(`run create failed: ${(err as Error).message}; reporter disabled`);
      this.cfg = null;
    }
  }

  onTestBegin(_test: TestCase, _result: TestResult): void {
    // No-op (OB-372): we used to spawn `observo run case set --status
    // in_progress` here so the dashboard lit a case up as the suite
    // walked through it. The CLI never accepted `in_progress` though
    // — allowed statuses are passed/failed/skipped/blocked — so every
    // CI invocation logged a hard error and the writeback failed.
    //
    // The cost of dropping the live mid-test indicator is small: the
    // dashboard still updates progressively as onTestEnd fires per
    // case, and the run UI distinguishes "not_started" cases anyway.
    // Re-introduce this if/when the CLI grows a `running` (or similar
    // non-terminal) status — until then, silence beats spammy errors.
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    if (!this.cfg) return;
    const code = extractShortCode(test);
    if (!code) return;

    // Skip intermediate retry attempts. Playwright fires onTestEnd
    // once per attempt (0..retries). If we write `failed` for attempt
    // 0 then `passed` for attempt 1, that's correct lineage — but if
    // attempt 1's PATCH errors transiently the dashboard is stuck at
    // `failed` for a test that actually passed. Write only definitive
    // state: the last attempt, OR an earlier attempt that already
    // passed, OR a skipped test (skipped fires exactly once with
    // retry=0 and never retries; carve-out is required so skipped
    // cases don't stay queued).
    if (
      result.status !== "skipped" &&
      result.retry < test.retries &&
      result.status !== "passed"
    ) {
      return;
    }

    const status = mapStatus(result.status);

    // OB-405: per-example targeting for parametrized cases. Compute once per
    // test (annotations don't change between steps of the same invocation).
    // null = classic / non-parametrized → omit the flag, server falls through
    // to its single-run-case path.
    const exampleCells = extractExampleCells(test, (m) => this.warn(m));
    const exampleCellsArg = exampleCells ? JSON.stringify(exampleCells) : null;

    // 1. Case status — ONLY for classic (non-parametrized) cases.
    //
    // For parametrized cases (exampleCells present): OB-401 derives the parent
    // case status by rolling up the per-example rows. The per-step writes below
    // carry --example-cells and land on the correct example row; the parent
    // badge is computed from those by the server. Issuing `run case set`
    // here would either no-op or — worse — silently target the first example
    // row via ambiguous match (case-level path doesn't see --example-cells:
    // observo-cli v0.8.x exposes the flag only on `run case step set`,
    // precedent: OB-373 finding #2 removed --comment for the same reason).
    //
    // OB-373 finding #2 historical note: previously appended `--comment` here
    // but CLI v0.7.x did not declare it; the failure context survives via the
    // per-step --comment we pass below + the orchestrator workflow's
    // failure-summary.md attachment.
    if (!exampleCells) {
      const caseArgs = [
        "run",
        "case",
        "set",
        "--run-id",
        this.runKey,
        "--code",
        code,
        "--status",
        status,
      ];
      this.fireAndForget(caseArgs);
    }

    // 2. Top-level test.step PATCHes (1-based).
    const steps = userSteps(result.steps);
    if (steps.some((s) => s.steps?.some((c) => c.category === "test.step"))) {
      this.warn(
        `${code}: nested test.step() detected — only top-level steps PATCH; nested ones stay at queued. Flatten in test code to surface them.`,
      );
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStatus = step.error ? "failed" : "passed";
      const args = [
        "run",
        "case",
        "step",
        "set",
        "--run-id",
        this.runKey,
        "--code",
        code,
        "--step",
        String(i + 1),
        "--status",
        stepStatus,
      ];
      if (step.error?.message) args.push("--comment", step.error.message);
      if (exampleCellsArg) args.push("--example-cells", exampleCellsArg);
      this.fireAndForget(args);
    }

    // OB-405 follow-up: parametrized case with ZERO test.step() calls.
    // The case-level skip above would leave the example row at its initial
    // not_started state forever — the rollup has nothing to roll up. Emit
    // an overall-status write against step 1 of the targeted example so
    // the example row picks up the run's outcome, analogous to how the
    // classic path's `run case set` covers a no-steps test. If the case
    // template has zero step rows the server returns "step number 1 not
    // found" and the existing OB-373 dedup'd warning surfaces it.
    //
    // Round 3 review: the step endpoint is constrained to "passed"/"failed"
    // by the per-step loop above (line 462 — Playwright `test.step()` errors
    // only yield those two). The case-level endpoint accepts the full
    // {passed, failed, blocked, skipped} set; sending the full mapStatus
    // output here would mirror that asymmetry. Collapse non-pass → "failed"
    // to match the step-endpoint contract — a timedOut/blocked test surfaces
    // as failure (which is what the user wants to see), and a skipped test
    // also surfaces as failure with the cells in the row (less precise than
    // a true skip, but the alternative is leaving the row stuck at
    // not_started which reads as a silent reporter drop).
    if (exampleCellsArg && steps.length === 0) {
      const synthStatus = status === "passed" ? "passed" : "failed";
      const args = [
        "run",
        "case",
        "step",
        "set",
        "--run-id",
        this.runKey,
        "--code",
        code,
        "--step",
        "1",
        "--status",
        synthStatus,
        "--example-cells",
        exampleCellsArg,
      ];
      this.fireAndForget(args);
    }

    // 3. Attachments — only on failed/blocked unless uploadPassed.
    //    Storage bounded on a green run; debug-relevant attachments
    //    survive the gate.
    if (status === "failed" || status === "blocked" || this.cfg.uploadPassed) {
      for (const att of result.attachments) {
        if (!att.path) {
          // Inline body attachments (small custom test.info().attach
          // payloads) lack a file path — skipped in v1, matching CLI
          // run_import behaviour. Warn so the user knows.
          if (att.body) {
            this.warn(
              `${code}: skipping inline attachment ${JSON.stringify(att.name)} (v1 uploads path-backed only)`,
            );
          }
          continue;
        }
        // OB-436: route attachments to the case drawer (--case flag,
        // added in CLI v0.8.0). OB-437: when the spec has an
        // observo-cells annotation, also pass --example-cells so the
        // upload lands on the SPECIFIC example row of a parametrized
        // case — same pattern the case / case-step PATCHes already use
        // above (lines 459 / 484 / 524). Requires CLI v0.8.1+ on the
        // resolver path; older CLIs reject --example-cells as an
        // unknown flag and the upload drops (already covered by the
        // CI install-pin bump in observo/PR #411).
        const args = [
          "run",
          "attach",
          "--run-id",
          this.runKey,
          "--case",
          code,
          "--file",
          att.path,
        ];
        if (exampleCellsArg) args.push("--example-cells", exampleCellsArg);
        this.fireAndForget(args);
      }
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.cfg) return;

    // OB-434: drain in-flight fire-and-forget uploads before yielding
    // back to Playwright. Without this, the process exits as soon as
    // onEnd resolves and Node sends SIGTERM to every still-running
    // child — case-status PATCHes (~200 B) usually beat the signal,
    // but trace.zip / video / screenshot uploads (1–3 MB streamed to
    // presigned S3) lose the race and never reach the dashboard.
    // Snapshot the pool first: late additions from concurrent test
    // teardown would otherwise extend the wait indefinitely.
    const drainPool = this.pendingChildren.slice();
    if (drainPool.length > 0) {
      const settled = Promise.allSettled(drainPool);
      const timeoutHandle: { v?: NodeJS.Timeout } = {};
      const deadline = new Promise<"timeout">((resolve) => {
        timeoutHandle.v = setTimeout(
          () => resolve("timeout"),
          ObservoReporter.DRAIN_DEADLINE_MS,
        );
      });
      const outcome = await Promise.race([settled.then(() => "done" as const), deadline]);
      if (timeoutHandle.v) clearTimeout(timeoutHandle.v);
      if (outcome === "timeout") {
        this.warn(
          `drain timeout (${Math.round(ObservoReporter.DRAIN_DEADLINE_MS / 1000)}s) — ${drainPool.length} CLI children still in-flight; uploads may be incomplete.`,
        );
      }
    }

    // OB-373 finding #4: emit a `pipeline.layers[]` aggregate before
    // returning, so `observo run finish --status auto` (called by the
    // orchestrator OR by us below) can see a Playwright pass/fail
    // outcome alongside the four backend layers (mcp-unit,
    // mcp-contract, frontend-unit, server-integration). Without this
    // entry, run-row auto-status rollup ignores e2e entirely and
    // drifts toward `failed` even when per-case PATCHes are clean.
    //
    // Gated on the same activation as the rest of the reporter
    // (this.cfg is set ↔ OBSERVO_API_KEY present). Awaited rather
    // than fire-and-forget because the orchestrator's `run finish`
    // step in the next CI job races us otherwise — a layer that
    // lands after run finish is invisible to that finish call.
    // Customer-direct mode (createdRun=true) calls run finish below
    // on the same connection; awaiting first keeps that ordering
    // intact too.
    await this.emitPipelineLayer();

    if (!this.createdRun) {
      // CI orchestrator owns the run lifecycle; we don't close it.
      return;
    }
    try {
      await this.runCli([
        "run",
        "finish",
        "--run-id",
        this.runKey,
        "--status",
        "auto",
      ]);
    } catch (err) {
      this.warn(`run finish failed: ${(err as Error).message}`);
    }
  }

  private async emitPipelineLayer(): Promise<void> {
    if (!this.cfg) return;
    if (this.opts.pipelineLayer === false) return;

    const overrides =
      typeof this.opts.pipelineLayer === "object" && this.opts.pipelineLayer
        ? this.opts.pipelineLayer
        : {};
    const layerId = overrides.layerId || "e2e";
    const displayName = overrides.displayName || "E2E (Playwright)";
    const framework = overrides.framework || "playwright";
    const junitPath =
      overrides.junitPath ||
      (this.fullConfig ? findJunitOutput(this.fullConfig) : null);

    if (!junitPath) {
      // Playwright's `junit` reporter not configured → no XML on disk
      // for the CLI to parse. Per-case writeback still works; only
      // the layer-aggregate roll-up is missing. One-line warning so
      // the user can add the reporter if they want auto-status to
      // include e2e.
      this.warn(
        `pipeline-layer skipped: configure Playwright's 'junit' reporter with outputFile (or pass pipelineLayer.junitPath) to enable run-row auto-status rollup for e2e.`,
      );
      return;
    }

    try {
      await this.runCli([
        "run",
        "pipeline-layer",
        "set",
        "--run-id",
        this.runKey,
        "--layer-id",
        layerId,
        "--display-name",
        displayName,
        "--framework",
        framework,
        "--junit",
        junitPath,
      ]);
    } catch (err) {
      // Non-fatal: per-case PATCHes already landed; missing layer
      // only affects auto-status rollup. Warn and continue.
      this.warn(`pipeline-layer set failed: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------
  // CLI spawn helpers
  // -----------------------------------------------------------------

  /**
   * Build the common arg prefix every CLI invocation needs: --api-key,
   * --base-url (when set), --project (when known).
   *
   * OB-372: `--project` is now passed on every invocation. The CLI's
   * subcommands (notably `run case step set`) require both --project
   * AND --run-id when no local `.observo-pipeline-state.json` is
   * present — which is the common case for multi-job CI pipelines
   * where `run create` runs in an upstream job and the test job
   * starts with a clean workspace. Pre-existing subcommands that
   * accept --project but don't require it (run create, run finish)
   * are happy to receive it redundantly.
   */
  private commonArgs(): string[] {
    if (!this.cfg) return [];
    const out: string[] = ["--api-key", this.cfg.apiKey];
    if (this.cfg.baseUrl) out.push("--base-url", this.cfg.baseUrl);
    if (this.cfg.project) out.push("--project", this.cfg.project);
    return out;
  }

  /**
   * Fire-and-forget CLI spawn. Used for per-test PATCH / attach hot
   * paths so Playwright reporter callbacks don't block waiting for
   * network round-trips — a slow Observo API would otherwise stretch
   * the test suite by N × latency.
   *
   * Failures log a warning and are ignored. The CLI itself retries
   * 5xx + 429 + 408 internally (3 attempts, exp backoff); persistent
   * errors after that are genuinely the customer's network /
   * misconfig.
   */
  private fireAndForget(verbArgs: string[]): void {
    if (!this.cfg) return;
    const args = [...this.commonArgs(), ...verbArgs];
    const child = spawn(this.cfg.cliPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    // OB-434: register a settle-on-close promise so onEnd can drain the
    // pool before returning. Use 'close' (final FD release), not 'exit'
    // (process ended but stdio may still be flushing). 'error' also
    // resolves — Node fires 'error' but NOT 'close' on spawn failure
    // (e.g. ENOENT before the process is forked), so without this both
    // listeners the promise would hang forever.
    let settle: () => void;
    this.pendingChildren.push(new Promise<void>((r) => (settle = r)));
    child.on("error", (err) => {
      // ENOENT typically — `observo` not on PATH.
      this.warn(`spawn ${this.cfg?.cliPath} failed: ${err.message}`);
      settle();
    });
    child.on("close", (code) => {
      settle();
      if (code === 0) return;
      // OB-373 finding #3: per-step `step number N not found` 404s
      // when the spec emits more `test.step()` calls than the case
      // has step rows. The over-count steps have nowhere to land —
      // per-row 404s neither carry signal nor break writeback for
      // the steps that DID land. Surface ONE info line per case and
      // suppress the rest so CI logs stay readable.
      if (
        verbArgs[0] === "run" &&
        verbArgs[1] === "case" &&
        verbArgs[2] === "step" &&
        verbArgs[3] === "set" &&
        /step number \d+ not found/i.test(stderr)
      ) {
        const codeIdx = verbArgs.indexOf("--code");
        const codeVal = codeIdx >= 0 ? verbArgs[codeIdx + 1] : "";
        // OB-405 follow-up: include --example-cells in the dedup key so each
        // parametrized example's over-count warning surfaces independently;
        // before this the second example was silently suppressed because the
        // first one already added the bare code to the set.
        const cellsIdx = verbArgs.indexOf("--example-cells");
        const cellsVal = cellsIdx >= 0 ? verbArgs[cellsIdx + 1] : "";
        const dedupKey = cellsVal ? `${codeVal}:${cellsVal}` : codeVal;
        if (codeVal && !this.stepNotFoundWarnedFor.has(dedupKey)) {
          this.stepNotFoundWarnedFor.add(dedupKey);
          const exampleSuffix = cellsVal ? ` (example ${cellsVal})` : "";
          this.warn(
            `${codeVal}${exampleSuffix}: spec emits more test.step()s than the case has step rows — over-count steps skipped (this is fine).`,
          );
        }
        return;
      }
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      this.warn(`CLI ${verbArgs.slice(0, 3).join(" ")} exit ${code}: ${tail}`);
    });
  }

  /**
   * Synchronous CLI spawn that captures stdout — used only for
   * `run create` in onBegin (we need the run_key back) and
   * `run finish` in onEnd (sequencing matters; a fire-and-forget
   * finish could race the workflow's tear-down step).
   */
  private runCli(
    verbArgs: string[],
    opts: { captureStdout?: boolean } = {},
  ): Promise<string> {
    if (!this.cfg) return Promise.resolve("");
    const args = [...this.commonArgs(), ...verbArgs];
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg!.cliPath, args, {
        stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += String(d);
      });
      child.stderr?.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          const tail = stderr.trim().split("\n").slice(-3).join(" | ");
          reject(new Error(`exit ${code}: ${tail || "no stderr"}`));
        }
      });
    });
  }

  private warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[@observo-ai/playwright-reporter] ${msg}`);
  }
}

export default ObservoReporter;
