---
name: signalk-server-e2e
description: Use when a change to the SignalK server or a SignalK plugin needs a real browser-level end-to-end check before opening a PR — spin up a local server, drive its Admin UI / plugin config panel / Freeboard-SK with Playwright headlessly, feed live data over the WebSocket delta stream, and attach the passing run as PR evidence. Covers the WebSocket-delta feed for position/values, the headless-Chrome gotcha, and driving Module-Federation config panels.
---

# End-to-end test a SignalK server or plugin change in a real browser

When a change touches server behavior a unit test can't reach — Admin UI, a plugin's config
panel, data reaching Freeboard-SK, the delta/stream path — verify it in a real browser against a
running server before you open the PR. This is the browser-level complement to the server's own
`npm test`; it catches the "serves fine but the UI never shows it" class of bug that mocked
tests miss.

## 0. Use the repo's own Playwright chromium, not the MCP browser

Run the browser through the target repo's `@playwright/test` chromium from a scratch script —
**not** a system/MCP-provided browser. The MCP browser typically wants system Chrome, which is
often absent on a headless dev box; the repo's bundled chromium is already the right version and
downloads once. Add it where you run the script:

```bash
npm i -D @playwright/test && npx playwright install chromium
```

Then a throwaway `e2e.mjs` (or a `*.spec.ts` under the repo's test dir) drives it. Prefer a
scratch script for one-off verification; promote to a committed spec if the check is worth
keeping in CI.

## 1. Spin up the server under test

Start a real server on a throwaway config dir so you never touch a live install:

```bash
# from the signalk-server checkout; -c points at a scratch data dir
PORT=4000 npm start -- -c /tmp/sk-e2e
```

- **Plugin under test**: symlink your plugin into the server's `node_modules` (or `npm i` it as
  a `file:` dep) so a `npm run build` in the plugin dir is picked up on the next server restart —
  no `npm link` dance. Rebuild the plugin, restart the server, then run the browser check.
- **Security**: with security disabled (fresh scratch config) the `/signalk/v1/stream` WebSocket
  accepts unauthenticated deltas and the resource/data APIs are anonymously readable — which is
  what makes headless e2e cheap. If you must test an admin-gated path, log in through the UI in
  the Playwright script and reuse the storage state.
- Wait for readiness by polling an HTTP endpoint (e.g. `GET /signalk` returns 200) before
  launching the browser — "process started" ≠ "server answering".

## 2. Feed live data over the WebSocket delta stream

Most SignalK UI behavior is data-driven, so the test usually needs to *produce* data, not just
read it. Push deltas to the stream from Node (global `WebSocket`, Node ≥ 22) on an interval —
e.g. a vessel position so a chart follows the boat:

```js
const ws = new WebSocket("ws://localhost:4000/signalk/v1/stream?subscribe=none");
ws.onopen = () => setInterval(() => ws.send(JSON.stringify({
  updates: [{ values: [{ path: "navigation.position",
    value: { latitude: 60.1, longitude: 24.9 } }] }],
})), 2000);
```

Send every ~2 s so the value doesn't age out of the UI. `subscribe=none` keeps the socket
one-directional (you're writing, not reading). Verify the value landed via the REST API
(`GET /signalk/v2/api/…` or `/signalk/v1/api/vessels/self/...`) *and* in the browser, so a
green REST read plus a blank UI localizes the bug to the front end.

## 3. Drive the browser

Load the surface under test and assert on what the user would see. Verify by a combination of
DOM assertions, observed network requests (`page.on("response", …)` counting the tile/API calls
the feature should trigger), and a screenshot for the trace.

- **Admin UI / a plugin config panel**: SignalK loads config panels as **Module-Federation
  remotes** (`remoteEntry.js` exposing `./PluginConfigurationPanel`). If the panel is blank,
  check the console for _"Module … is not available"_ — that's the ESM-vs-CJS remote mismatch
  (an `"type": "module"` plugin needs an ESM remote), not your test. Interact with the real
  controls (buttons, selects) and assert the resulting status/API call.
- **Freeboard-SK charts** (verified recipe): don't seed `localStorage` `freeboard_config` — the
  app overrides map center/selection from it. Instead feed `navigation.position` over WS (§2)
  and load `?zoom=N&movemap=1&northup=1` (the only hostParams). Open the layers panel via
  `button:has(mat-icon:text-is("layers"))`; each chart is a `mat-card` containing an
  `input[type="checkbox"]` — `setChecked(true, { force: true })`, and uncheck 'World Map' / 'Sea
  Map' first so only the chart under test renders. Assert on `page.on("response")` matches for
  `/resources/charts/<id>/z/x/y`.

## 4. The headless-Chrome gotcha (canvas/WebGL/map apps)

A `<canvas>`/WebGL/MapLibre surface (Freeboard, chart tiles, three.js) often renders **blank**
or crashes the page under naive headless Chrome — recent Chrome can't create a software WebGL
context. Launch with the new headless mode and, if frames are blank, fall back to headful under
`xvfb` on a display-less box:

```js
const browser = await chromium.launch({ headless: true }); // Playwright's chromium == "new" headless
// still blank? run headful under a virtual display:  xvfb-run -a node e2e.mjs
```

Give the map a beat to paint (`await page.waitForTimeout` after the tiles' network requests
settle, or wait on a known canvas/DOM signal) before screenshotting.

## 5. Gate the PR on it — test before you open the PR

Treat a green browser run as a precondition for opening the PR, not an afterthought:

1. Build the change, restart the server, run the e2e script — it must pass.
2. Capture evidence: the screenshot(s) and/or the Playwright **trace**
   (`chromium.launch` → `context.tracing.start({ screenshots: true, snapshots: true })`).
3. Only then open the PR, and put the evidence in the body — a one-line "Tested" note stating
   exactly what ran (server on :4000, position fed over WS, chart X rendered N tiles, screenshot
   attached). List only what actually ran; never a speculative test plan.

A reviewer seeing "e2e-verified: chart renders after WS position feed, screenshot attached"
trusts the change far more than "should work". If the run is worth keeping, commit it as a spec
so CI re-runs it.

## Gotchas recap

- Repo's bundled `@playwright/test` chromium, not the MCP/system browser.
- Scratch `-c` config dir; never point at a live `~/.signalk`.
- Poll for HTTP readiness before launching the browser.
- Feed WS deltas every ~2 s; `subscribe=none`; global `WebSocket` needs Node ≥ 22.
- Blank canvas ⇒ headless-WebGL; retry headful under `xvfb`.
- Blank config panel ⇒ ESM-vs-CJS Module-Federation remote mismatch, not the test.
