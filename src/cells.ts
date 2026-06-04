/**
 * OB-405: convenience helper for parametrized tests. Returns a Playwright
 * test annotation that the Observo reporter reads to route per-step writes to
 * the matching example run-case (server matches by exact parameter equality,
 * OB-423).
 *
 * Typical use — inline annotation on the test:
 *
 *   import { observoCells } from "@observo-ai/playwright-reporter";
 *
 *   test(
 *     "login works on chromium",
 *     {
 *       tag: ["@observo:WEB-7"],
 *       annotation: observoCells({ browser: "chromium" }),
 *     },
 *     async ({ page }) => { ... },
 *   );
 *
 * — or inside the test body when the cell set is computed at runtime:
 *
 *   test("login", async ({ page }, testInfo) => {
 *     testInfo.annotations.push(observoCells({ browser: process.env.BROWSER! }));
 *     // ...
 *   });
 *
 * Cell values must be strings. The server matches param_values EXACTLY (every
 * key from the test maps, no extras on either side), so you must send all the
 * cells the case is parametrized by — a subset will resolve to NotFound.
 */
export function observoCells(
  cells: Record<string, string>,
): { type: "observo-cells"; description: string } {
  return { type: "observo-cells", description: JSON.stringify(cells) };
}
