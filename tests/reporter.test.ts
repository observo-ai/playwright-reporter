import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// Mock node:child_process BEFORE importing the reporter — vi.mock is
// hoisted automatically. We capture every spawn() invocation in a
// shared array so the test body can assert against it.
const spawnCalls: { cmd: string; args: string[] }[] = [];

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
        const idx = args.indexOf("create");
        if (idx >= 0 && args[idx - 1] === "run") {
          ee.stdout.emit("data", JSON.stringify({ run_key: "RUN-42" }));
        }
        ee.emit("close", 0);
      });
      return ee;
    },
  };
});

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
}): any {
  return {
    title: opts.title || "some test",
    tags: opts.tags || [],
    retries: opts.retries ?? 0,
    parent: opts.parentTitle ? { title: opts.parentTitle, parent: undefined } : undefined,
  };
}

function fakeResult(opts: {
  status?: string;
  retry?: number;
  steps?: any[];
  attachments?: any[];
  error?: { message?: string; stack?: string };
}): any {
  return {
    status: opts.status || "passed",
    retry: opts.retry ?? 0,
    steps: opts.steps || [],
    attachments: opts.attachments || [],
    error: opts.error,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  spawnCalls.length = 0;
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
