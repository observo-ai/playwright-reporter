import { describe, expect, it, vi } from "vitest";
import { observoCells } from "../src/cells";
import { extractExampleCells } from "../src/reporter";
import type { TestCase } from "@playwright/test/reporter";

// OB-405: extractExampleCells reads the annotation that observoCells() writes
// and turns it back into a Record<string,string> for the reporter to forward
// to the CLI as --example-cells. The two functions are inverses on the happy
// path, so we exercise them together where useful.

function mockTest(annotations: Array<{ type: string; description?: string }>, title = "test") {
  return { title, annotations } as unknown as TestCase;
}

describe("observoCells helper", () => {
  it("returns a Playwright annotation with type observo-cells + JSON description", () => {
    const ann = observoCells({ browser: "chromium" });
    expect(ann.type).toBe("observo-cells");
    expect(JSON.parse(ann.description)).toEqual({ browser: "chromium" });
  });

  it("preserves key order under JSON.stringify (alphabetical not guaranteed)", () => {
    // The server matches by EXACT param-value equality (jsonb @>/<@), which is
    // set-semantics — key order doesn't matter on the server. But asserting
    // here protects against silent reorderings if we ever switch encoders.
    const ann = observoCells({ browser: "firefox", locale: "de" });
    expect(ann.description).toBe('{"browser":"firefox","locale":"de"}');
  });
});

describe("extractExampleCells reader", () => {
  it("returns null when no observo-cells annotation is present", () => {
    const warn = vi.fn();
    const test = mockTest([{ type: "skip", description: "flaky" }]);
    expect(extractExampleCells(test, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses a flat object back into a Record<string,string>", () => {
    const warn = vi.fn();
    const test = mockTest([
      observoCells({ browser: "chromium", locale: "en-US" }),
    ]);
    expect(extractExampleCells(test, warn)).toEqual({
      browser: "chromium",
      locale: "en-US",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("last annotation wins when multiple observo-cells are present (override semantics)", () => {
    const warn = vi.fn();
    const test = mockTest([
      observoCells({ browser: "chromium" }),
      observoCells({ browser: "firefox" }),
    ]);
    expect(extractExampleCells(test, warn)).toEqual({ browser: "firefox" });
  });

  it("skips and warns when the description is missing", () => {
    const warn = vi.fn();
    const test = mockTest([{ type: "observo-cells" }]);
    expect(extractExampleCells(test, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips and warns on malformed JSON", () => {
    const warn = vi.fn();
    const test = mockTest([
      { type: "observo-cells", description: "{browser:chromium}" },
    ]);
    expect(extractExampleCells(test, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips and warns when the JSON is not a flat object (array)", () => {
    const warn = vi.fn();
    const test = mockTest([
      { type: "observo-cells", description: '["chromium"]' },
    ]);
    expect(extractExampleCells(test, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips and warns when a value is not a string", () => {
    const warn = vi.fn();
    const test = mockTest([
      { type: "observo-cells", description: '{"browser":"chromium","retries":3}' },
    ]);
    expect(extractExampleCells(test, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips and warns on an empty object (no cells to match)", () => {
    const warn = vi.fn();
    const test = mockTest([{ type: "observo-cells", description: "{}" }]);
    expect(extractExampleCells(test, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
