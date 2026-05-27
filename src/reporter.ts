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

class ObservoReporter implements Reporter {
  private opts: ReporterOptions;
  private cfg: ResolvedConfig | null = null;
  private runKey: string = ""; // resolved at onBegin (either env or created)
  private createdRun: boolean = false; // tracks whether we owe an onEnd finish

  constructor(opts: ReporterOptions = {}) {
    this.opts = opts;
  }

  async onBegin(config: FullConfig, _suite: Suite): Promise<void> {
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
    const comment = result.error?.message
      ? `${result.error.message}${result.error.stack ? `\n\n${result.error.stack}` : ""}`
      : "";

    // 1. Case status.
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
    if (comment) caseArgs.push("--comment", comment);
    this.fireAndForget(caseArgs);

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
        const args = [
          "run",
          "attach",
          "--run-id",
          this.runKey,
          "--code",
          code,
          "--file",
          att.path,
        ];
        this.fireAndForget(args);
      }
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.cfg) return;
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
    child.on("error", (err) => {
      // ENOENT typically — `observo` not on PATH.
      this.warn(`spawn ${this.cfg?.cliPath} failed: ${err.message}`);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        this.warn(`CLI ${verbArgs.slice(0, 3).join(" ")} exit ${code}: ${tail}`);
      }
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
