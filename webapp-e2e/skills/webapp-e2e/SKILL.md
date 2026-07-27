---
name: webapp-e2e
description: Use when a change to a web app — a dev server, a live URL, or an isolated UI component like a plugin config panel — needs a real browser-level end-to-end check before opening a PR. Covers driving the app with Playwright (the repo's bundled chromium, not a system/MCP browser), the headless-Chrome blank-canvas gotcha, mounting an isolated component for test, and attaching the passing run as PR evidence.
---

# End-to-end test a web app change in a real browser

When a change touches behavior a unit test can't reach — a rendered page, an interactive
control, a component that only misbehaves once mounted and talking to a real backend — verify it
in a real browser before opening the PR. This is about **verifying** the app works, distinct
from recording a demo GIF of it (`record-web-gif`) and from any SignalK-server-specific harness
(`signalk-server-e2e`).

## 0. Use the repo's bundled chromium, not the MCP/system browser

Drive the browser through `@playwright/test`'s own chromium from a scratch script — not a
system-provided or MCP browser, which usually wants a system Chrome that's often absent on a
headless box and is the wrong version anyway. Install where you run the check:

```bash
npm i -D @playwright/test && npx playwright install chromium
```

A throwaway `e2e.mjs` is right for one-off verification; a committed `*.spec.ts` under the repo's
test dir is right when the check should run in CI. Prefer `@playwright/test`'s `expect` +
auto-waiting locators over raw `page.waitForSelector` — they retry until the condition holds,
which kills most flakiness.

## 1. Point it at the app

- **A dev server**: start it (`npm run dev`), then **poll for readiness** — a `fetch(url)`
  returning 200, or `page.goto(url, { waitUntil: "networkidle" })` — before asserting. "Process
  started" ≠ "app serving"; racing the first `goto` is the top source of flaky first runs.
- **A live URL**: `page.goto(url)` directly. Keep destructive interactions out of production.
- **An isolated component** (a plugin config panel, a design-system widget) that has no page of
  its own: mount it in a tiny host page and load that. See §3.

## 2. Drive it and assert like a user

Assert on what a user would observe, through the public surface — rendered text, control state,
and the network calls a working feature makes:

```js
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const apiCalls = [];
page.on("response", (r) => r.url().includes("/api/") && apiCalls.push(r.url()));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Check for updates" }).click();
await expect(page.getByText(/Update available|Up to date/)).toBeVisible();
// the feature should have hit the backend:
expect(apiCalls.some((u) => u.includes("/api/update/check"))).toBe(true);
```

- Prefer role/label/text locators (`getByRole`, `getByLabel`, `getByText`) over CSS/XPath — they
  survive markup churn and encode accessibility.
- Combine three signals for a solid check: a **DOM assertion** (the user sees the result), an
  **observed network request** (the feature actually called the backend), and a **screenshot**
  for the trace. A green DOM assertion alone can pass on cached/stale UI.
- For anything time-dependent, wait on a real signal (a response, a selector, `expect`
  auto-wait) — never a bare `waitForTimeout` as the primary gate; it's flaky and slow.

## 3. Mounting an isolated component for test

A component with no standalone page (a plugin config panel, a federated remote) still needs a
host to render in. Build it, then load a minimal HTML shell that mounts it and stubs its
backend:

- Build the component/bundle (`npm run build`) so you're testing the shipped artifact, not the
  source.
- Serve a tiny `test/host.html` that imports the built entry, provides whatever the component
  expects from its host (props, a `save`/`configuration` callback, a React singleton for a
  federation remote), and route its API calls to a stub server (`page.route("**/api/**", …)`) so
  the test is deterministic and offline.
- **Module-Federation remotes**: the remote's module format must match how the host loads it —
  an ESM host uses dynamic `import()` and needs an ESM remote (`library: { type: "module" }`); a
  copied CJS `var` remote loads with no exports and the mount dies with _"Module … is not
  available"_ even though serving worked. Verify the container shape first:
  `node -e 'import("./public/remoteEntry.js").then(m => console.log(typeof m.get, typeof m.init))'`
  — both must print `function`.

## 4. The headless-Chrome blank-canvas gotcha

A `<canvas>`, WebGL, or map surface (charts, three.js, MapLibre) often renders **blank** or
crashes the page under naive headless Chrome — recent Chrome can't create a software WebGL
context. Use Playwright's chromium (already "new" headless); if frames are still blank, run
headful under a virtual display on a display-less box:

```bash
xvfb-run -a node e2e.mjs
```

Let the surface paint before you screenshot — wait until its tile/data requests settle, or on a
known canvas/DOM signal, not a fixed sleep.

## 5. Gate the PR on it — test before you open the PR

A green browser run is a **precondition** for opening the PR, not a follow-up:

1. Build, start (or point at) the app, run the e2e check — it must pass.
2. Capture evidence: screenshot(s) and/or a Playwright **trace**
   (`context.tracing.start({ screenshots: true, snapshots: true })` → `tracing.stop({ path })`),
   which a reviewer can open in `npx playwright show-trace`.
3. Only then open the PR, with the evidence in the body and a one-line "Tested" note stating
   exactly what ran (URL/port, the interaction, the assertion that passed, screenshot attached).
   List only what actually ran — never a speculative plan.

"e2e-verified: update-check button shows result and calls /api/update/check, screenshot
attached" earns far more reviewer trust than "should work". If the check is worth keeping,
commit it as a spec so CI re-runs it on every PR.

## Gotchas recap

- Repo's bundled `@playwright/test` chromium, not the MCP/system browser.
- Poll for readiness before the first `goto`; `networkidle` for SPAs.
- Role/label/text locators + auto-waiting `expect`; avoid bare `waitForTimeout`.
- Assert DOM **and** the network call the feature should make.
- Blank canvas ⇒ headless-WebGL; retry headful under `xvfb`.
- Blank federated component ⇒ ESM-vs-CJS remote mismatch, not the test.
