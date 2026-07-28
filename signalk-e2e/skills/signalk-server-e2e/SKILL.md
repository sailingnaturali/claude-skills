---
name: signalk-server-e2e
description: Use when a change to the SignalK server or a SignalK plugin needs a real browser-level end-to-end check before opening a PR — spin up a local server on a scratch config, drive its Admin UI / plugin config panel / Freeboard-SK, and feed live data over the WebSocket delta stream so data-driven UI actually has data. The SignalK-specific layer on top of the webapp-e2e skill (which covers the shared browser mechanics — bundled chromium, locators, the headless blank-canvas gotcha, PR-evidence gating).
---

# End-to-end test a SignalK server or plugin change in a real browser

When a change touches server behavior a unit test can't reach — Admin UI, a plugin's config
panel, data reaching Freeboard-SK, the delta/stream path — verify it in a real browser against a
running server before you open the PR. This is the browser-level complement to the server's own
`npm test`; it catches the "serves fine but the UI never shows it" class of bug that mocked
tests miss.

**This skill is the SignalK-specific layer.** The shared browser mechanics live in the companion
`webapp-e2e` skill (always installed alongside this one): using the repo's bundled
`@playwright/test` chromium instead of a system/MCP browser, role/label locators + auto-waiting
`expect`, mounting a Module-Federation component, the headless-Chrome blank-canvas gotcha, and
the PR-evidence gating. Read `webapp-e2e` for those; below is only what's specific to a SignalK
server.

## 1. Spin up the server under test

Start a real server on a throwaway config dir so you never touch a live install:

```bash
# from the signalk-server checkout; -c points at a scratch data dir
mkdir -p /tmp/sk-e2e
PORT=4000 npm start -- -c /tmp/sk-e2e &
SK_PID=$!
```

- **Readiness gate**: poll an HTTP endpoint until it answers (`GET /signalk` returns 200) *before*
  launching the browser — "process started" ≠ "server answering". Make this `fetch`-poll the
  primary gate; a SignalK UI holds its delta WebSocket open, so `page.goto(..., { waitUntil:
  "networkidle" })` may never fire and is only a fallback for the page load itself.

  ```js
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch("http://localhost:4000/signalk")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  ```
- **Plugin under test**: symlink your plugin into the server's `node_modules` (or `npm i` it as a
  `file:` dep) so a `npm run build` in the plugin dir is picked up on the next server restart — no
  `npm link` dance. Rebuild the plugin, restart the server, then run the browser check.
- **Security**: with security disabled (fresh scratch config) the `/signalk/v1/stream` WebSocket
  accepts unauthenticated deltas and the resource/data APIs are anonymously readable — which is
  what makes headless e2e cheap. If you must test an admin-gated path, log in through the UI in the
  Playwright script and reuse the storage state.
- **Teardown**: always kill the server and remove the scratch dir when done, even on failure, so a
  wedged `:4000` or a stale config doesn't poison the next run:

  ```bash
  kill "$SK_PID" 2>/dev/null; rm -rf /tmp/sk-e2e
  ```
  (In an `e2e.mjs`, spawn the server with `child_process` and kill it in a `finally`.)

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
(`GET /signalk/v2/api/…` or `/signalk/v1/api/vessels/self/...`) *and* in the browser, so a green
REST read plus a blank UI localizes the bug to the front end.

## 3. Drive the SignalK surfaces

Load the surface under test and assert on what the user would see (DOM + observed network
requests + screenshot — see `webapp-e2e` §2). The two SignalK-specific surfaces:

- **A plugin config panel**: SignalK loads config panels as **Module-Federation remotes**
  (`remoteEntry.js` exposing `./PluginConfigurationPanel`). If the panel is blank, check the
  console for _"Module … is not available"_ — that's the ESM-vs-CJS remote mismatch (a
  `"type": "module"` plugin needs an ESM remote), not your test. See `webapp-e2e` §3 for verifying
  the remote's container shape.
- **Freeboard-SK charts** — verified recipe (*verified against Freeboard-SK v2.x, July 2026; the
  selectors track the app's Angular Material markup and rot with releases — re-verify against the
  installed version if a locator misses*): don't seed `localStorage` `freeboard_config` — the app
  overrides map center/selection from it. Instead feed `navigation.position` over WS (§2) and load
  `?zoom=N&movemap=1&northup=1` (the only hostParams). Open the layers panel via
  `button:has(mat-icon:text-is("layers"))`; each chart is a `mat-card` containing an
  `input[type="checkbox"]` — `setChecked(true, { force: true })`, and uncheck 'World Map' / 'Sea
  Map' first so only the chart under test renders. Assert on `page.on("response")` matches for
  `/resources/charts/<id>/z/x/y`.

## 4. Gate the PR on it

Same rule as `webapp-e2e` §5: a green browser run is a **precondition** for opening the PR, not an
afterthought. Build the change, restart the server, run the e2e script — it must pass — then
capture evidence (screenshot and/or Playwright trace) and put a one-line "Tested" note in the PR
body stating exactly what ran (server on :4000, position fed over WS, chart X rendered N tiles,
screenshot attached). List only what actually ran, never a speculative plan. If the run is worth
keeping, commit it as a spec so CI re-runs it.

## Gotchas recap

- Scratch `-c` config dir; never point at a live `~/.signalk`. Kill the server + `rm -rf` the dir
  on teardown.
- `fetch`-poll HTTP readiness before launching the browser; `networkidle` may never fire (delta
  WebSocket stays open).
- Feed WS deltas every ~2 s; `subscribe=none`; global `WebSocket` needs Node ≥ 22.
- Blank config panel ⇒ ESM-vs-CJS Module-Federation remote mismatch, not the test.
- Shared mechanics (bundled chromium, locators, headless blank-canvas, evidence) → `webapp-e2e`.
