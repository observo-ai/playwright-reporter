import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// Mock node:child_process BEFORE importing the reporter — vi.mock is
// hoisted automatically. We capture every spawn() invocation in a
// shared array so the test body can assert against it.
const spawnCalls: { cmd: string; args: string[] }[] = [];

// Per-test override for the mocked spawn's exit code / stderr / stdout.
// Returning `null` (the default) keeps the legacy behaviour: exit 0,
// stdout JSON only for `run create` calls. Used by OB-373 tests that
// need to assert reporter behaviour on a non-zero CLI exit (e.g. the
// step-number 404 path).
type SpawnOverride = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  // OB-434: delay the close emit by N ms so a test can assert onEnd
  // genuinely awaits in-flight uploads. Default (undefined) keeps the
  // legacy immediate-close behaviour every other test relies on.
  closeDelayMs?: number;
  // OB-434: skip the close emit entirely — the child stays alive until
  // the test instructs it otherwise via the returned handle. Used to
  // exercise the drain-deadline timeout path.
  neverClose?: boolean;
};
let spawnBehavior: (args: string[]) => SpawnOverride | null = () => null;

vi.mock("node:child_process", () => {
  return {
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      // Return a minimal mock ChildProcess-like object: an EventEmitter
      // with stdout/stderr EventEmitters and an immediate `close 0`.
      // Reporter listens to `error` / `close` / `stdout.data` only.
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      // Allow the test to intercept stdout for runCli (run create)
      // before we close — push canned JSON when args match.
      setImmediate(() => {
        const override = spawnBehavior(args);
        if (override?.stdout !== undefined) {
          ee.stdout.emit("data", override.stdout);
        } else {
          const idx = args.indexOf("create");
          if (idx >= 0 && args[idx - 1] === "run") {
            ee.stdout.emit("data", JSON.stringify({ run_key: "RUN-42" }));
          }
        }
        if (override?.stderr) ee.stderr.emit("data", override.stderr);
        if (override?.neverClose) return;
        const close = () => ee.emit("close", override?.exitCode ?? 0);
        if (override?.closeDelayMs && override.closeDelayMs > 0) {
          setTimeout(close, override.closeDelayMs);
        } else {
          close();
        }
      });
      return ee;
    },
  };
});

// Drain pending setImmediate / microtask queue so reporter's
// fire-and-forget `child.on("close", ...)` callbacks have actually
// fired before the test asserts against logged warnings.
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// Import AFTER vi.mock so the reporter binds to the mocked spawn.
import ObservoReporter from "../src/reporter";

// Lightweight fake objects matching the shape the reporter actually
// reads from Playwright's types. We don't pull @playwright/test types
// at runtime because the reporter never invokes them — only reads
// fields.
function fakeTest(opts: {
  title?: string;
  tags?: string[];
  retries?: number;
  parentTitle?: string;
  annotations?: { type: string; description?: string }[];
}): any {
  return {
    title: opts.title || "some test",
    tags: opts.tags || [],
    retries: opts.retries ?? 0,
    annotations: opts.annotations ?? [],
    parent: opts.parentTitle ? { title: opts.parentTitle, parent: undefined } : undefined,
  };
}

function fakeResult(opts: {
  status?: string;
  retry?: number;
  steps?: any[];
  attachments?: any[];
  error?: { message?: string; stack?: string };
  errors?: { message?: string; stack?: string }[];
}): any {
  return {
    status: opts.status || "passed",
    retry: opts.retry ?? 0,
    steps: opts.steps || [],
    attachments: opts.attachments || [],
    error: opts.error,
    errors: opts.errors,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  // Drain any setImmediate callbacks queued by prior tests' fire-
  // and-forget spawns BEFORE we reset spawnBehavior. Otherwise a
  // close handler queued by test N runs under test N+1's spawn
  // override and fires warnings against a stale reporter instance —
  // pollutes the next test's console.warn spy without dedupe
  // protection (the prior reporter's per-case Set is unrelated to
  // the new test's reporter).
  await new Promise<void>((resolve) => setImmediate(resolve));
  spawnCalls.length = 0;
  spawnBehavior = () => null;
  // Reset env to a known-clean state per test.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("OBSERVO_")) delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("activation gate", () => {
  it("no-ops entirely when OBSERVO_API_KEY is unset", async () => {
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    r.onTestBegin(fakeTest({ tags: ["@observo:WEB-7"] }), fakeResult({}));
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({ status: "failed" }),
    );
    await r.onEnd({ status: "failed" } as any);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("run lifecycle", () => {
  it("creates a run on onBegin when OBSERVO_RUN_KEY is unset", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_PROJECT = "WEB";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain("create");
    expect(spawnCalls[0].args).toContain("--project");
    expect(spawnCalls[0].args).toContain("WEB");
  });

  it("attaches to an existing run when OBSERVO_RUN_KEY is set (no run create)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    expect(spawnCalls).toHaveLength(0); // no run create
  });

  it("attaches to an existing run when opts.runKey is set (no env required)", async () => {
    // v0.1.1: explicit option path. Mirrors the env behaviour above but
    // wires `runKey` through Playwright reporter options at the config
    // call site — the self-documenting form.
    process.env.OBSERVO_API_KEY = "k";
    delete process.env.OBSERVO_RUN_KEY;
    const r = new ObservoReporter({ runKey: "RUN-77" });
    await r.onBegin({} as any, {} as any);
    expect(spawnCalls).toHaveLength(0); // no run create — option populated cfg.runKey
  });

  it("opts.runKey takes precedence over OBSERVO_RUN_KEY env when both set", async () => {
    // Tie-breaker: explicit option wins so a stray env in the runner
    // never overrides what playwright.config.ts declared.
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "ENV-RUN";
    const r = new ObservoReporter({ runKey: "OPT-RUN" });
    await r.onBegin({} as any, {} as any);
    expect(spawnCalls).toHaveLength(0); // still skips create
    // Subsequent CLI calls (onTestEnd writeback) use the option value,
    // not the env value. onTestBegin no longer spawns (OB-372), so we
    // sample the run-id from the case set call instead.
    const test = fakeTest({ tags: ["@observo:OB-1"] });
    await r.onTestEnd(test as any, fakeResult({ status: "passed" }));
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("OPT-RUN");
    expect(caseSet?.args).not.toContain("ENV-RUN");
  });

  it("calls run finish on onEnd only when reporter created the run", async () => {
    // 1. Reporter created the run: finish IS called.
    process.env.OBSERVO_API_KEY = "k";
    let r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onEnd({ status: "passed" } as any);
    expect(spawnCalls.some((c) => c.args.includes("finish"))).toBe(true);

    // 2. Pre-created run (OBSERVO_RUN_KEY set): finish is NOT called.
    spawnCalls.length = 0;
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onEnd({ status: "passed" } as any);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("short-code resolution", () => {
  it("explicit @observo:CODE-N tag wins over title", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    const test = fakeTest({
      title: "login — WEB-99",
      tags: ["@smoke", "@observo:WEB-7"],
    });
    await r.onTestEnd(test, fakeResult({ status: "failed" }));
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("WEB-7");
    expect(caseSet?.args).not.toContain("WEB-99");
  });

  it("falls back to code in title", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    await r.onTestEnd(
      fakeTest({ title: "WEB-7 login flow" }),
      fakeResult({ status: "failed" }),
    );
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("WEB-7");
  });

  it("falls back to code in parent suite title (innermost first)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    await r.onTestEnd(
      fakeTest({ title: "login flow", parentTitle: "WEB-7 Auth" }),
      fakeResult({ status: "failed" }),
    );
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("WEB-7");
  });

  it("skips tests with no resolvable short code", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ title: "some unrelated test" }),
      fakeResult({ status: "failed" }),
    );
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("retry handling", () => {
  it("skips intermediate failing retries (waits for definitive attempt)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    const test = fakeTest({ tags: ["@observo:WEB-7"], retries: 2 });
    // First failing attempt — should NOT PATCH.
    spawnCalls.length = 0;
    await r.onTestEnd(test, fakeResult({ status: "failed", retry: 0 }));
    expect(spawnCalls.filter((c) => c.args.includes("set"))).toHaveLength(0);
    // Last attempt — PATCHes.
    await r.onTestEnd(test, fakeResult({ status: "failed", retry: 2 }));
    expect(spawnCalls.some((c) => c.args.includes("set"))).toBe(true);
  });

  it("PATCHes a passed-on-retry even before the last attempt", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    const test = fakeTest({ tags: ["@observo:WEB-7"], retries: 2 });
    spawnCalls.length = 0;
    await r.onTestEnd(test, fakeResult({ status: "passed", retry: 1 }));
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("passed");
  });
});

describe("project resolution (OB-372)", () => {
  it("reads OBSERVO_PROJECT_CODE (CLI's canonical env name)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_PROJECT_CODE = "OB";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:OB-7"] }),
      fakeResult({ status: "passed" }),
    );
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toEqual(
      expect.arrayContaining(["--project", "OB"]),
    );
  });

  it("OBSERVO_PROJECT_CODE wins over OBSERVO_PROJECT (CLI name preferred)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_PROJECT_CODE = "CANONICAL";
    process.env.OBSERVO_PROJECT = "LEGACY";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:OB-7"] }),
      fakeResult({ status: "passed" }),
    );
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("CANONICAL");
    expect(caseSet?.args).not.toContain("LEGACY");
  });

  it("passes --project on case + step + attach when project is known", async () => {
    // Multi-job CI: --project + --run-id together let `run case step
    // set` succeed without a local .observo-pipeline-state.json.
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_PROJECT_CODE = "OB";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:OB-7"] }),
      fakeResult({
        status: "failed",
        steps: [{ title: "step 1", category: "test.step", steps: [] }],
        attachments: [{ name: "trace", path: "/tmp/t.zip" }],
      }),
    );
    // All three CLI verbs land in the spawn list with --project.
    const verbs = ["set", "step", "attach"];
    for (const verb of verbs) {
      const match = spawnCalls.find((c) => c.args.includes(verb));
      expect(match, `no spawn found for verb ${verb}`).toBeDefined();
      expect(match?.args).toEqual(
        expect.arrayContaining(["--project", "OB"]),
      );
    }
  });
});

describe("onTestBegin no-op (OB-372)", () => {
  it("does NOT spawn CLI on test begin (CLI rejects in_progress status)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_PROJECT_CODE = "OB";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    r.onTestBegin(
      fakeTest({ tags: ["@observo:OB-7"] }) as any,
      fakeResult({}) as any,
    );
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("status mapping", () => {
  it("maps timedOut and interrupted to blocked", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({ status: "timedOut" }),
    );
    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set"),
    );
    expect(caseSet?.args).toContain("blocked");
  });
});

describe("attachments", () => {
  it("uploads on failed but not on passed (default)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);

    // Failed → attachment uploaded.
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        attachments: [{ name: "video", path: "/tmp/v.webm" }],
      }),
    );
    expect(spawnCalls.some((c) => c.args.includes("attach"))).toBe(true);

    // Passed → no attachment.
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "passed",
        attachments: [{ name: "video", path: "/tmp/v.webm" }],
      }),
    );
    expect(spawnCalls.some((c) => c.args.includes("attach"))).toBe(false);
  });

  it("respects uploadPassed: true option", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter({ uploadPassed: true });
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "passed",
        attachments: [{ name: "video", path: "/tmp/v.webm" }],
      }),
    );
    expect(spawnCalls.some((c) => c.args.includes("attach"))).toBe(true);
  });

  it("skips inline body attachments (warns; v1 path-only)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        attachments: [{ name: "blob", body: "aGVsbG8=" }],
      }),
    );
    // No `attach` calls — inline body is skipped.
    expect(spawnCalls.some((c) => c.args.includes("attach"))).toBe(false);
  });
});

describe("steps", () => {
  it("PATCHes only top-level test.step categories (1-based)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "passed",
        steps: [
          { title: "Open page", category: "test.step", steps: [] },
          { title: "expect.toBeVisible", category: "expect", steps: [] },
          { title: "Click submit", category: "test.step", steps: [] },
          { title: "afterEach hook", category: "hook", steps: [] },
        ],
      }),
    );
    const stepCalls = spawnCalls.filter(
      (c) => c.args.includes("step") && c.args.includes("set"),
    );
    // Exactly 2 test.step entries → 2 step PATCHes, indices 1 and 2.
    expect(stepCalls).toHaveLength(2);
    expect(stepCalls[0].args).toContain("1");
    expect(stepCalls[1].args).toContain("2");
  });
});

// -----------------------------------------------------------------
// OB-373 — reporter ↔ CLI v0.7.x contract gaps closed in v0.1.3.
// -----------------------------------------------------------------

describe("OB-373: run case set does not pass unknown --comment flag", () => {
  it("omits --comment on case set even when the test has an error message", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        error: { message: "expect.toBe failed", stack: "at line 42" },
      }),
    );
    const caseSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("set") &&
        !c.args.includes("step"),
    );
    expect(caseSet).toBeTruthy();
    // CLI v0.7.x's `run case set` does NOT declare --comment;
    // passing one would log `unknown flag: --comment` and the case
    // row would land without a status. Verified flag is absent.
    expect(caseSet!.args).not.toContain("--comment");
    expect(caseSet!.args).toContain("--status");
    expect(caseSet!.args).toContain("failed");
  });

  it("keeps per-step --comment when the step has an error (CLI does accept --comment on step set)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        steps: [
          {
            title: "click login",
            category: "test.step",
            steps: [],
            error: { message: "selector not found" },
          },
        ],
      }),
    );
    const stepSet = spawnCalls.find(
      (c) => c.args.includes("step") && c.args.includes("set"),
    );
    expect(stepSet).toBeTruthy();
    expect(stepSet!.args).toContain("--comment");
    expect(stepSet!.args).toContain("selector not found");
  });
});

describe("OB-436: run attach routes to case (not run-level)", () => {
  // History: OB-373 originally stripped --code because CLI v0.7.x
  // rejected it, so attachments fell to the run-level strip. CLI
  // v0.8.0 added a proper --case flag, so the workaround is now
  // stale — case-drawer attachments are the headline Wave-3 UX
  // promise. The pre-OB-436 invariant ("attach does NOT contain
  // --code") is intentionally inverted here.
  it("passes --case <code> AND --file on every attach call", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        attachments: [
          { name: "trace", path: "/tmp/trace.zip" },
          { name: "screenshot", path: "/tmp/shot.png" },
        ],
      }),
    );
    const attaches = spawnCalls.filter((c) => c.args.includes("attach"));
    expect(attaches.length).toBe(2);
    for (const attach of attaches) {
      // OB-436: --case + value must be adjacent so the CLI gets the
      // pair, not just an orphan flag.
      const idx = attach.args.indexOf("--case");
      expect(idx, "attach call missing --case flag").toBeGreaterThanOrEqual(0);
      expect(attach.args[idx + 1]).toBe("WEB-7");
      // Run-id still present (case + run-id together resolve the
      // run-case row server-side).
      expect(attach.args).toContain("--run-id");
      expect(attach.args).toContain("RUN-99");
      expect(attach.args).toContain("--file");
    }
    // Both files routed to the same case (WEB-7), distinct --file values.
    const files = attaches.map((c) => c.args[c.args.indexOf("--file") + 1]).sort();
    expect(files).toEqual(["/tmp/shot.png", "/tmp/trace.zip"]);
  });

  // OB-437: parametrized attach. When the spec has an observo-cells
  // annotation, the reporter must also pass --example-cells on every
  // run attach call so the upload lands on the correct example row of
  // the parametrized case. Mirror of the case-step PATCH pattern in
  // run_case_test.go and the run_attach CLI test in observo-cli.
  it("passes --example-cells when the spec has an observo-cells annotation", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({
        tags: ["@observo:PARAM-3"],
        annotations: [
          { type: "observo-cells", description: JSON.stringify({ browser: "firefox" }) },
        ],
      }),
      fakeResult({
        status: "failed",
        attachments: [
          { name: "trace", path: "/tmp/trace.zip" },
          { name: "screenshot", path: "/tmp/shot.png" },
        ],
      }),
    );
    const attaches = spawnCalls.filter((c) => c.args.includes("attach"));
    expect(attaches.length).toBe(2);
    for (const attach of attaches) {
      const idx = attach.args.indexOf("--example-cells");
      expect(idx, "attach call missing --example-cells").toBeGreaterThanOrEqual(0);
      // Adjacent value, exact JSON match — server compares cells as a
      // structured map; the wire form is what the CLI parses.
      expect(JSON.parse(attach.args[idx + 1])).toEqual({ browser: "firefox" });
      // --case must still be present (cells disambiguate AMONG example
      // rows of a specific case; the case identity is required).
      expect(attach.args).toContain("--case");
      expect(attach.args).toContain("PARAM-3");
    }
  });

  // OB-437: classic (non-parametrized) cases keep the v0.2.2 shape —
  // --example-cells must NOT be passed on attach when the spec has no
  // observo-cells annotation, otherwise older CLI/server versions
  // (pre-v0.8.1) would reject the call as an unknown flag and the
  // upload would drop.
  it("omits --example-cells when the spec has no observo-cells annotation", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        attachments: [{ name: "trace", path: "/tmp/trace.zip" }],
      }),
    );
    const attach = spawnCalls.find((c) => c.args.includes("attach"));
    expect(attach).toBeTruthy();
    expect(attach!.args).not.toContain("--example-cells");
  });
});

describe("OB-373: step-number 404 is benign (deduped per case)", () => {
  it("warns once per case when CLI returns step-not-found, silent on subsequent steps", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    // Make every `run case step set` spawn exit non-zero with the
    // exact stderr shape the server emits on over-count steps.
    spawnBehavior = (args) => {
      if (
        args.includes("step") &&
        args.includes("set") &&
        args[args.indexOf("step") - 1] === "case"
      ) {
        return {
          stderr:
            "HTTP 404 on /api/runs/x/cases/WEB-7/steps/5: step number 5 not found for test case",
          exitCode: 1,
        };
      }
      return null;
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    // Three over-count steps in a single test — the reporter should
    // collapse to one warning for the case, not three.
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        steps: [
          { title: "s1", category: "test.step", steps: [] },
          { title: "s2", category: "test.step", steps: [] },
          { title: "s3", category: "test.step", steps: [] },
        ],
      }),
    );
    await flushAsync();

    const stepNotFoundLogs = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((s) => s.includes("over-count steps skipped"));
    expect(stepNotFoundLogs).toHaveLength(1);
    expect(stepNotFoundLogs[0]).toContain("WEB-7");

    // Equally important: the GENERIC "CLI ... exit 1: ..." warning
    // path must NOT fire for these step-set calls — otherwise the
    // dedupe achieved nothing for the operator reading CI logs.
    const noisyLogs = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((s) => s.includes("CLI run case exit"));
    expect(noisyLogs).toHaveLength(0);

    warnSpy.mockRestore();
  });
});

describe("OB-373: pipeline-layer aggregate in onEnd", () => {
  it("emits `run pipeline-layer set` with junit path auto-detected from FullConfig.reporter[]", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    const fullConfig = {
      reporter: [
        ["list"],
        ["junit", { outputFile: "playwright-report/junit.xml" }],
      ],
    } as any;
    await r.onBegin(fullConfig, {} as any);
    spawnCalls.length = 0;
    await r.onEnd({ status: "passed" } as any);
    const layerSet = spawnCalls.find(
      (c) => c.args.includes("pipeline-layer") && c.args.includes("set"),
    );
    expect(layerSet).toBeTruthy();
    expect(layerSet!.args).toContain("--layer-id");
    expect(layerSet!.args).toContain("e2e");
    expect(layerSet!.args).toContain("--framework");
    expect(layerSet!.args).toContain("playwright");
    expect(layerSet!.args).toContain("--junit");
    expect(layerSet!.args).toContain("playwright-report/junit.xml");
    expect(layerSet!.args).toContain("--run-id");
    expect(layerSet!.args).toContain("RUN-99");
  });

  it("skips emission with a warning when no junit reporter is configured", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ObservoReporter();
    await r.onBegin({ reporter: [["list"]] } as any, {} as any);
    spawnCalls.length = 0;
    await r.onEnd({ status: "passed" } as any);
    expect(
      spawnCalls.some(
        (c) => c.args.includes("pipeline-layer") && c.args.includes("set"),
      ),
    ).toBe(false);
    const skipLogs = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((s) => s.includes("pipeline-layer skipped"));
    expect(skipLogs).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("honours option overrides (layerId / displayName / framework / junitPath)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter({
      pipelineLayer: {
        layerId: "smoke",
        displayName: "Smoke (Playwright)",
        framework: "playwright",
        junitPath: "custom/path/junit.xml",
      },
    });
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;
    await r.onEnd({ status: "passed" } as any);
    const layerSet = spawnCalls.find(
      (c) => c.args.includes("pipeline-layer") && c.args.includes("set"),
    );
    expect(layerSet).toBeTruthy();
    expect(layerSet!.args).toContain("smoke");
    expect(layerSet!.args).toContain("Smoke (Playwright)");
    expect(layerSet!.args).toContain("custom/path/junit.xml");
  });

  it("does not emit when pipelineLayer is explicitly disabled (false)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter({ pipelineLayer: false });
    const fullConfig = {
      reporter: [["junit", { outputFile: "playwright-report/junit.xml" }]],
    } as any;
    await r.onBegin(fullConfig, {} as any);
    spawnCalls.length = 0;
    await r.onEnd({ status: "passed" } as any);
    expect(
      spawnCalls.some(
        (c) => c.args.includes("pipeline-layer") && c.args.includes("set"),
      ),
    ).toBe(false);
  });
});

// OB-405: case-level write must SKIP parametrized cases. The CLI's
// `run case set` has no --example-cells flag (v0.8.x exposes the flag only on
// `run case step set`), and per OB-401 the parent case status is derived from
// the per-example rollup anyway. Issuing a case-level write here would either
// no-op or silently target the first example row by ambiguous match — the
// auto-review on PR #5 caught this. Precedent: OB-373 finding #2 removed
// --comment from case-level writes for the same reason.
describe("OB-405 case-level write skips parametrized cases", () => {
  it("classic case (no observo-cells annotation): emits `run case set`", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:CLASSIC-1"] }) as any,
      fakeResult({ status: "passed" }),
    );

    const caseSet = spawnCalls.find(
      (c) => c.args.includes("case") && c.args.includes("set") && c.args.includes("CLASSIC-1"),
    );
    expect(caseSet, "classic case must emit `run case set`").toBeTruthy();
  });

  it("parametrized case (observo-cells annotation present): skips `run case set`", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    const annotations = [
      { type: "observo-cells", description: JSON.stringify({ browser: "firefox" }) },
    ];
    // Provide at least one step so the step-level path fires too — proves it
    // continues to carry --example-cells while the case-level path skips.
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:PARAM-1"], annotations }) as any,
      fakeResult({
        status: "passed",
        steps: [{ category: "test.step", title: "s1", steps: [] }],
      }),
    );

    // Case-level write must be ABSENT for the parametrized case.
    const caseSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("set") &&
        !c.args.includes("step") &&
        c.args.includes("PARAM-1"),
    );
    expect(caseSet, "parametrized case must NOT emit `run case set`").toBeFalsy();

    // Step-level write must still fire, with --example-cells carrying the cells.
    const stepSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set") &&
        c.args.includes("PARAM-1"),
    );
    expect(stepSet, "step-level write still fires").toBeTruthy();
    expect(stepSet!.args).toContain("--example-cells");
    const idx = stepSet!.args.indexOf("--example-cells");
    expect(JSON.parse(stepSet!.args[idx + 1])).toEqual({ browser: "firefox" });
  });

  // Auto-review round 2, finding 1 (HIGH): parametrized + zero test.step()
  // calls would emit no writes at all post-case-skip — example row would stay
  // not_started silently. Synthesize a step-1 write so the example picks up
  // the overall status.
  it("parametrized case with NO test.step() calls: synthesizes a step-1 write with cells", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    const annotations = [
      { type: "observo-cells", description: JSON.stringify({ browser: "chromium" }) },
    ];
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:PARAM-2"], annotations }) as any,
      fakeResult({ status: "passed", steps: [] }),
    );

    const caseSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("set") &&
        !c.args.includes("step") &&
        c.args.includes("PARAM-2"),
    );
    expect(caseSet, "no case-level write for parametrized").toBeFalsy();

    const stepSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set") &&
        c.args.includes("PARAM-2"),
    );
    expect(stepSet, "synthetic step-1 write fires").toBeTruthy();
    expect(stepSet!.args).toContain("--step");
    expect(stepSet!.args[stepSet!.args.indexOf("--step") + 1]).toBe("1");
    expect(stepSet!.args).toContain("--status");
    expect(stepSet!.args[stepSet!.args.indexOf("--status") + 1]).toBe("passed");
    expect(stepSet!.args).toContain("--example-cells");
    const idx = stepSet!.args.indexOf("--example-cells");
    expect(JSON.parse(stepSet!.args[idx + 1])).toEqual({ browser: "chromium" });
  });

  // Auto-review round 3 (MEDIUM): the synthesised step-1 write must collapse
  // non-pass statuses (timedOut → "blocked", skipped → "skipped") to
  // "failed" — the step endpoint per the existing per-step loop only ever
  // receives "passed"/"failed". Sending "blocked"/"skipped" risks a 4xx that
  // would leave the example row stuck at not_started.
  it("parametrized + NO test.step() + timedOut: synth step status collapses to failed", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    const annotations = [
      { type: "observo-cells", description: JSON.stringify({ browser: "firefox" }) },
    ];
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:PARAM-4"], annotations }) as any,
      fakeResult({ status: "timedOut", steps: [] }),
    );

    const stepSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set") &&
        c.args.includes("PARAM-4"),
    );
    expect(stepSet, "synth step-1 fires").toBeTruthy();
    const sIdx = stepSet!.args.indexOf("--status");
    expect(stepSet!.args[sIdx + 1]).toBe("failed");
  });

  it("parametrized + NO test.step() + skipped: synth step status collapses to failed", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    const annotations = [
      { type: "observo-cells", description: JSON.stringify({ browser: "webkit" }) },
    ];
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:PARAM-5"], annotations }) as any,
      fakeResult({ status: "skipped", steps: [] }),
    );

    const stepSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set") &&
        c.args.includes("PARAM-5"),
    );
    expect(stepSet, "synth step-1 fires").toBeTruthy();
    const sIdx = stepSet!.args.indexOf("--status");
    expect(stepSet!.args[sIdx + 1]).toBe("failed");
  });

  // Symmetric guard: classic case with NO test.step() calls keeps its
  // existing behavior — case-level write fires, no synthetic step-1.
  it("classic case with NO test.step() calls: case-level write only (no synthetic step)", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:CLASSIC-2"] }) as any,
      fakeResult({ status: "passed", steps: [] }),
    );

    const caseSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("set") &&
        !c.args.includes("step") &&
        c.args.includes("CLASSIC-2"),
    );
    expect(caseSet, "classic case-level write fires").toBeTruthy();
    const stepSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set") &&
        c.args.includes("CLASSIC-2"),
    );
    expect(stepSet, "no synthetic step write for classic").toBeFalsy();
  });

  // Auto-review round 2, finding 2 (LOW): "step number N not found" dedup
  // was keyed by case code alone, suppressing the warning for the 2nd example
  // of the same parametrized case. Each distinct example must emit its own
  // warning.
  it("over-count step warning dedups per (code, example-cells) — not per code alone", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-1";

    // Force the spawned CLI to exit non-zero with the "step number N not found"
    // stderr for `run case step set` calls — same shape the server returns
    // when over-counting steps.
    // Reporter prepends `--api-key <k>` to every spawn — match on the
    // `case … step … set` triple inside the slice instead of by index 0.
    spawnBehavior = (args) => {
      if (
        args.includes("step") &&
        args.includes("set") &&
        args[args.indexOf("step") - 1] === "case"
      ) {
        return { exitCode: 1, stderr: "step number 1 not found" };
      }
      return null;
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = new ObservoReporter();
      await r.onBegin({} as any, {} as any);
      spawnCalls.length = 0;
      warnSpy.mockClear();

      // Two examples of the same case PARAM-3 — chromium and firefox.
      const mkAnno = (browser: string) => [
        { type: "observo-cells", description: JSON.stringify({ browser }) },
      ];
      for (const browser of ["chromium", "firefox"]) {
        await r.onTestEnd(
          fakeTest({ tags: ["@observo:PARAM-3"], annotations: mkAnno(browser) }) as any,
          fakeResult({
            status: "passed",
            steps: [{ title: "s", category: "test.step", steps: [] }],
          }),
        );
      }
      // Let the close handlers (queued via setImmediate by the spawn mock)
      // drain before asserting on console.warn.
      await flushAsync();

      const overCountWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("more test.step()s"));
      expect(
        overCountWarnings.length,
        `expected 2 distinct over-count warnings (one per example), got ${overCountWarnings.length}: ${JSON.stringify(overCountWarnings)}`,
      ).toBe(2);
      expect(overCountWarnings.some((m) => m.includes("chromium"))).toBe(true);
      expect(overCountWarnings.some((m) => m.includes("firefox"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("OB-434: onEnd drains in-flight fire-and-forget uploads", () => {
  // Regression for the silent-attachment-drop bug. Pre-OB-434, onEnd
  // returned immediately when `createdRun` is false (orchestrator-owned
  // run lifecycle — i.e. the production CI mode). The parent Node
  // process then exited and SIGTERM'd every still-running attach
  // child; case status PATCHes (~200 B) usually won the race but
  // trace.zip / video / screenshot uploads (1–3 MB streamed to
  // presigned S3) lost it, so failing cases landed on the dashboard
  // without their debug artifacts. Concrete miss observed on
  // run_2026060495 (PR #396, OB-55 broken deliberately): case
  // recorded as `failed` with step-7 error comment, ZERO attachments.
  it("onEnd does not resolve until all fire-and-forget children close", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_PROJECT_CODE = "OB";
    process.env.OBSERVO_RUN_KEY = "RUN-99"; // orchestrator-owned → createdRun=false

    // Hold every fire-and-forget child open for 80 ms so we can observe
    // that onEnd genuinely waits. The synchronous `run create` /
    // `run finish` paths (via runCli, not fireAndForget) close
    // immediately so the run-lifecycle calls aren't slowed.
    spawnBehavior = (args) => {
      const verb = `${args.includes("case") ? "case" : args.includes("attach") ? "attach" : ""}`;
      if (verb === "case" || verb === "attach") return { closeDelayMs: 80 };
      return null;
    };

    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    // Drive ONE failed test with 2 attachments — fires `run case set`
    // + `run attach × 2` via fireAndForget, total 3 pending children.
    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        attachments: [
          { name: "screenshot", path: "/tmp/screenshot.png", contentType: "image/png" },
          { name: "trace", path: "/tmp/trace.zip", contentType: "application/zip" },
        ],
      }),
    );

    const t0 = Date.now();
    await r.onEnd({} as any);
    const elapsed = Date.now() - t0;

    // onEnd must have waited at least one closeDelayMs window — proves
    // the new drain logic actually awaited the pool. Allow a small
    // floor margin (60 ms) for timer jitter on slow CI.
    expect(
      elapsed,
      `expected onEnd to await pending children (>=60ms), got ${elapsed}ms`,
    ).toBeGreaterThanOrEqual(60);
  });
});

// -----------------------------------------------------------------
// OB-396 — failure OUTSIDE test.step() nodes (browser launch fail,
// beforeAll throw, top-level timeout) used to drop ALL error context:
// the case row landed as failed, every step row stayed green, no
// message. Reporter now synthesises a step-1 write carrying
// result.error / result.errors[0].message so the cause reaches the
// dashboard.
// -----------------------------------------------------------------

describe("OB-396: top-level error surfaces as synthetic step-1", () => {
  // Helper — locate the step-1 set call (classic or parametrized).
  function findStepSet(code: string): { args: string[] } | undefined {
    return spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set") &&
        c.args.includes(code),
    );
  }

  it("classic + failed + zero steps + result.error: synth step-1 with --comment", async () => {
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        steps: [],
        error: {
          message: "browserType.launch: Executable doesn't exist at /ms-playwright/firefox-1466/firefox/firefox",
        },
      }),
    );

    const stepSet = findStepSet("WEB-7");
    expect(stepSet, "synth step-1 must fire").toBeTruthy();
    expect(stepSet!.args[stepSet!.args.indexOf("--step") + 1]).toBe("1");
    expect(stepSet!.args[stepSet!.args.indexOf("--status") + 1]).toBe("failed");
    expect(stepSet!.args).toContain("--comment");
    expect(stepSet!.args[stepSet!.args.indexOf("--comment") + 1]).toMatch(
      /browserType\.launch/,
    );
    // Classic case — no --example-cells.
    expect(stepSet!.args).not.toContain("--example-cells");
  });

  it("classic + timedOut + zero steps + result.error: synth step-1 status=failed", async () => {
    // timedOut maps to "blocked" at the case level but the step
    // endpoint only accepts passed/failed — collapse to failed (same
    // rule the OB-405 parametrized synth uses).
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "timedOut",
        steps: [],
        error: { message: "Test timeout of 30000ms exceeded." },
      }),
    );

    const stepSet = findStepSet("WEB-7");
    expect(stepSet, "synth step-1 must fire on timedOut too").toBeTruthy();
    expect(stepSet!.args[stepSet!.args.indexOf("--status") + 1]).toBe("failed");
    expect(stepSet!.args[stepSet!.args.indexOf("--comment") + 1]).toMatch(
      /Test timeout/,
    );
  });

  it("falls back to result.errors[0].message when result.error.message is empty string", async () => {
    // `||` not `??`: a blank `error.message` next to a non-blank
    // `errors[0].message` must surface the latter, not the empty
    // string (which would silently skip the synth).
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        steps: [],
        error: { message: "" },
        errors: [{ message: "fixture init: ECONNREFUSED" }],
      }),
    );

    const stepSet = findStepSet("WEB-7");
    expect(stepSet, "synth must fire from errors[] when error.message is blank").toBeTruthy();
    expect(stepSet!.args[stepSet!.args.indexOf("--comment") + 1]).toMatch(
      /ECONNREFUSED/,
    );
  });

  it("falls back to result.errors[0].message when result.error is unset", async () => {
    // Playwright populates result.errors[] even when result.error is
    // sometimes absent (e.g. multi-error fixture failures); the reporter
    // must read both shapes.
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        steps: [],
        errors: [
          { message: "beforeAll hook threw: ECONNREFUSED" },
          { message: "secondary error" },
        ],
      }),
    );

    const stepSet = findStepSet("WEB-7");
    expect(stepSet, "synth fires from errors[] fallback").toBeTruthy();
    expect(stepSet!.args[stepSet!.args.indexOf("--comment") + 1]).toMatch(
      /beforeAll hook threw/,
    );
  });

  it("failed but result.error/errors missing: no synth (nothing to say)", async () => {
    // Defensive: a broken upstream object should not produce a step
    // write with no --comment — the per-step loop's contract is that
    // every step write carries either pass/fail signal we actually own.
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({ status: "failed", steps: [] }),
    );

    const stepSet = findStepSet("WEB-7");
    expect(stepSet, "no synth without an error message").toBeFalsy();
    // Case-level set still fires so the row shows red.
    const caseSet = spawnCalls.find(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("set") &&
        !c.args.includes("step"),
    );
    expect(caseSet?.args).toContain("failed");
  });

  it("does NOT overwrite real per-step writes: skip synth when steps.length > 0", async () => {
    // Mixed case: top-level error fired AND at least one user step
    // ran. The per-step loop already carries the failing step's
    // --comment; writing a synth step-1 would clobber the existing
    // step-1 row (status / comment overwrite race). Restrict synth to
    // the no-steps shape — documented limitation, covered by OB-397
    // when case-level --comment becomes available.
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({ tags: ["@observo:WEB-7"] }),
      fakeResult({
        status: "failed",
        steps: [
          {
            title: "click submit",
            category: "test.step",
            steps: [],
            error: { message: "selector not found" },
          },
        ],
        error: { message: "afterEach hook threw" },
      }),
    );

    // Exactly ONE step-set call for step-1 — the per-step loop's, not
    // a synth on top of it.
    const stepSets = spawnCalls.filter(
      (c) =>
        c.args.includes("case") &&
        c.args.includes("step") &&
        c.args.includes("set"),
    );
    expect(stepSets).toHaveLength(1);
    expect(stepSets[0].args[stepSets[0].args.indexOf("--comment") + 1]).toBe(
      "selector not found",
    );
  });

  it("parametrized + failed + zero steps + result.error: synth step-1 carries --comment AND --example-cells", async () => {
    // Extends the OB-405 no-step parametrized synth: now also pushes
    // --comment when result.error is present. Without this the example
    // row landed as failed with zero context.
    process.env.OBSERVO_API_KEY = "k";
    process.env.OBSERVO_RUN_KEY = "RUN-99";
    const r = new ObservoReporter();
    await r.onBegin({} as any, {} as any);
    spawnCalls.length = 0;

    await r.onTestEnd(
      fakeTest({
        tags: ["@observo:PARAM-9"],
        annotations: [
          {
            type: "observo-cells",
            description: JSON.stringify({ browser: "firefox" }),
          },
        ],
      }),
      fakeResult({
        status: "failed",
        steps: [],
        error: { message: "browserType.launch firefox failed" },
      }),
    );

    const stepSet = findStepSet("PARAM-9");
    expect(stepSet).toBeTruthy();
    expect(stepSet!.args[stepSet!.args.indexOf("--status") + 1]).toBe("failed");
    expect(stepSet!.args).toContain("--example-cells");
    expect(
      JSON.parse(stepSet!.args[stepSet!.args.indexOf("--example-cells") + 1]),
    ).toEqual({ browser: "firefox" });
    expect(stepSet!.args).toContain("--comment");
    expect(stepSet!.args[stepSet!.args.indexOf("--comment") + 1]).toMatch(
      /firefox failed/,
    );
  });
});
