// Default export is what Playwright loads when users put
// `['@observo-ai/playwright-reporter']` (or with options:
// `['@observo-ai/playwright-reporter', { uploadPassed: true }]`) in
// their playwright.config.ts reporter list.
export { default } from "./reporter";

// OB-405: helper for parametrized tests to target a specific example by its
// parameter values (rather than its row index). See `observoCells` for usage.
export { observoCells } from "./cells";
