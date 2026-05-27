# @observo-ai/playwright-reporter

Playwright reporter for [Observo](https://observoai.co) — streams **live**
test status, retries, steps, and attachments to your Observo dashboard
during the run, so the dashboard lights up green/red test-by-test
instead of jumping from "queued" to a final aggregate at the end.

[![npm](https://img.shields.io/npm/v/@observo-ai/playwright-reporter)](https://www.npmjs.com/package/@observo-ai/playwright-reporter)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

## Install

```bash
npm install --save-dev @observo-ai/playwright-reporter
```

You also need the [`observo` CLI](https://github.com/observo-ai/observo-cli)
on `PATH` (the reporter shells to it for every event — keeping the CLI
as the single ingestion channel):

```bash
curl -fsSL https://cli.observoai.co/install | bash -s -- --version v0.7.1
observo --version
```

## Configure

Add the reporter to your `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  // …rest of your config…
  reporter: [
    ['list'],
    ['@observo-ai/playwright-reporter'],
  ],
});
```

Then set the required env vars wherever Playwright runs (`.env`, CI
workflow secrets, shell profile):

| Var | Required | Default | Notes |
|---|---|---|---|
| `OBSERVO_API_KEY` | yes | — | Account-scoped key from [Settings → API Keys](https://app.observoai.co/settings/api-keys) |
| `OBSERVO_PROJECT_CODE` | yes | — | Project short code (e.g. `WEB`) or UUID. Matches the env name the `observo` CLI itself documents — set this once in your CI workflow and both the CLI and the reporter see it. `OBSERVO_PROJECT` is still accepted as a fallback for backward compatibility. |
| `OBSERVO_BASE_URL` | no | `https://api.observoai.co` | Override for self-hosted / staging |
| `OBSERVO_RUN_KEY` | no | — | Attach to an existing run (e.g. created by CI orchestrator). When unset, the reporter creates a new run via `observo run create`. |
| `OBSERVO_PLAN` | no | — | Plan key to associate the run with (only when reporter creates the run) |
| `OBSERVO_CLI_PATH` | no | `observo` | Override if the CLI is installed under a non-standard path |

If `OBSERVO_API_KEY` is unset, the reporter no-ops entirely — local
`npx playwright test` runs without the env variable cause zero
network traffic and zero warnings.

## How tests map to Observo cases

Every Playwright test must map to a case short code in your Observo
project (e.g. `WEB-7`, where `WEB` is your project prefix). The
reporter resolves it from three sources in priority order:

### 1. Explicit `@observo:CODE-N` annotation tag (recommended)

```ts
test('login redirect', { tag: ['@observo:WEB-7'] }, async ({ page }) => {
  // …
});
```

Unambiguous, refactor-safe, and the same convention the
[bulk CLI importer](https://github.com/observo-ai/observo-cli) uses.

### 2. `CODE-N` token in the test title

```ts
test('WEB-7 redirect after submit', async ({ page }) => { /* … */ });
```

### 3. `CODE-N` token in a parent `describe()`

```ts
describe('WEB-7 Auth', () => {
  test('login redirect', async ({ page }) => { /* … */ });
});
```

Nested `describe()` blocks are searched **innermost first**, so

```ts
describe('WEB-3 Feature', () => {
  describe('WEB-5 Sub-feature', () => {
    test('flow', /* … */);
  });
});
```

resolves to `WEB-5`, not `WEB-3`.

Tests with no resolvable short code are skipped silently — the
reporter writes nothing for them and the run continues.

## What gets written per test

| Event | Observo action |
|---|---|
| `onBegin` | Create a new run via `observo run create` (skipped when `OBSERVO_RUN_KEY` is set — orchestrator owns the lifecycle) |
| `onTestBegin` | _no-op_ — case row is initialised in `not_started` and the dashboard surfaces it as in-flight while the run is open. (Prior versions tried to write a non-terminal `in_progress` status which the CLI does not accept; the writeback failed silently.) |
| `onTestEnd` | `observo run case set` with the final status, plus per-step `observo run case step set` calls |
| Failed/blocked cases | `observo run attach` for every path-backed `result.attachments[]` entry (`video.webm`, `trace.zip`, screenshots, custom test artifacts) |
| `onEnd` | `observo run finish --status auto` (skipped when reporter didn't create the run) |

### Status mapping

Playwright's `TestResult.status` maps to Observo's case status enum:

| Playwright | Observo |
|---|---|
| `passed` | `passed` |
| `failed` | `failed` |
| `skipped` | `skipped` |
| `timedOut` | `blocked` |
| `interrupted` | `blocked` |

`timedOut` / `interrupted` map to `blocked` because they're
infrastructure-level conditions, not real assertion failures — the
dashboard surfaces them differently so you can triage them
separately from real test regressions.

### Retries and flakiness

Playwright fires `onTestEnd` once per attempt. The reporter waits for
the **definitive** attempt before PATCHing — last attempt, or any
earlier attempt that already passed — so a `failed → retry → passed`
sequence shows up as `passed` in Observo (Playwright's retry count is
preserved on the case record for flakiness analysis).

### Steps

Only **top-level** `test.step()` calls map to Observo case steps. The
reporter does NOT flatten nested `test.step()` — server step numbering
in Observo follows the flat case definition, and flattening would
mis-align indices. If you want sub-step granularity in the dashboard,
flatten the calls in your test code.

## Options

```ts
reporter: [
  ['@observo-ai/playwright-reporter', {
    plan: 'REGRESSION',     // overrides OBSERVO_PLAN env
    uploadPassed: true,     // upload attachments on passing tests too
  }],
],
```

| Option | Default | Notes |
|---|---|---|
| `plan` | `OBSERVO_PLAN` env | Plan key passed to `observo run create` (no-op when `OBSERVO_RUN_KEY` is set) |
| `uploadPassed` | `false` | Upload attachments on passed/skipped tests. Default off to keep dashboard storage bounded on green runs. |

## Coexistence with `observo run import`

The reporter (this package) and the
[CLI's `run import --from playwright`](https://github.com/observo-ai/observo-cli)
are **complementary**, not redundant:

- **Use the reporter** when you control `playwright.config.ts` and
  want live dashboard updates + step-level signal.
- **Use `run import`** when Playwright runs in a third-party / legacy
  / locked-down environment where you can't install the reporter, or
  you want the simplest bash-only integration without an npm install.

Both write through the same backend; the dashboard result is identical
(modulo live-vs-post-mortem timing). They're safe to run against the
same run — the CLI's `EnsureAndUpdateRunCase` is idempotent and
last-writer-wins.

## Errors

The reporter is **non-fatal by design**: any CLI error (missing
binary, network glitch, server 5xx after retries) logs a warning to
stderr and is otherwise ignored. The test suite's exit code reflects
the actual Playwright outcome, not whether the reporter could reach
Observo.

If you see no live updates and your run isn't showing up:

1. `which observo` — is the CLI on PATH?
2. `observo --version` — at least `v0.7.1`?
3. Check your CI logs for lines starting with `[@observo-ai/playwright-reporter]`.

## License

[Apache 2.0](LICENSE)
