---
name: signalk-apis
description: Use when reading, streaming, or acting on Signal K server data — as a consumer (webapp, external app) or as a provider (server plugin). Corrects the core misconception that the v2 API supersedes v1 — they have different jobs. v1 is the data-model API (full tree REST, WebSocket delta stream, PUT actuation); v2 is a set of purpose-built domain APIs (course, resources, notifications, history, autopilot, weather) backed by provider plugins. Covers discovery, response envelopes, auth levels, provider registration, and the routing gotchas (admin-gated plugin routes, provider-less v2 routes that 404).
---

# Signal K APIs: v1 and v2 have different jobs

The most common misconception about the Signal K server APIs is that v2 is the successor of
v1 and v1 is on its way out. **Wrong — they serve different purposes and coexist by design:**

- **v1 is the data-model API.** One universal signal tree (`navigation.*`, `environment.*`,
  `electrical.*`, …) that every source feeds into, exposed three ways: REST snapshot, streaming
  WebSocket deltas, and PUT actuation. This is *the* way to read and stream live boat data, and
  nothing in v2 replaces it.
- **v2 is a set of domain APIs** — course, resources, notifications, history, autopilot,
  weather (radar in development) — each a purpose-built REST contract (OpenAPI definitions
  under *Documentation → OpenAPI* in the admin UI) for *operations* the flat data model can't
  express well ("activate this route", "acknowledge this alarm", "give me yesterday's SOG").
  The server owns the routes and keeps the data model consistent. Course and notifications are
  built into the server; the APIs that front hardware or storage — resources, autopilot,
  weather, history, radar — are implemented by plugins registering as *providers*.

New code typically uses both: stream positions over v1 while setting the course over v2.

## Consumer side (webapps, external apps)

- **Discover, don't hardcode.** `GET /signalk` returns the endpoints — and it advertises
  **v1 only** (`signalk-http`, `signalk-ws`, `signalk-tcp`). The v2 APIs are *not* in the
  discovery document; they live at the well-known `/signalk/v2/api/...` paths.
- **Read state (v1):** `GET /signalk/v1/api/vessels/self/<path with dots as slashes>` — a leaf
  returns `{ value, $source, timestamp, meta }` (`meta` carries units/description; multiple
  sources for one path appear under `values` keyed by `$source`).
- **Stream (v1):** `ws://…/signalk/v1/stream?subscribe=self|all|none`, then send
  `{ "context": "vessels.self", "subscribe": [{ "path": "navigation.*", "period": 1000 }] }`.
  Gotcha (as of 2.30.0): **top-level leaf paths like `name` and `mmsi` are not deliverable via
  subscriptions** — poll them over REST instead ([signalk-server#2829](https://github.com/SignalK/signalk-server/issues/2829)).
- **Operate the boat (v2):** e.g. course (`GET/PUT /signalk/v2/api/vessels/self/navigation/course/...`),
  resources CRUD (`/signalk/v2/api/resources/<type>`), notifications
  (`GET/POST /signalk/v2/api/notifications`, plus `:id/acknowledge`, `:id/silence`,
  `acknowledgeAll`, `silenceAll`, `mob` — this full surface ships in 2.30.0 even where older
  docs still mark it as pending). Writes return an envelope like
  `{ "state": "COMPLETED", "statusCode": 201, "id": "<uuid>" }`.
- **Generic actuation (v1 PUT):** `PUT /signalk/v1/api/vessels/self/<path>` with
  `{ "value": … }`. The response is the v1 request envelope —
  `{ "state", "statusCode", "message", "href": "/signalk/v1/requests/<id>" }`; poll `href`
  while `state` is `PENDING`. A path is only PUT-able if some plugin registered a handler for
  it (otherwise HTTP 405, `"PUT not supported for <path>"`).
- **History (v2):** `GET /signalk/v2/api/history/values?paths=<p1[:aggregate]>,…` with
  `from`/`to` (ISO 8601 timestamps), `duration` (seconds, or an ISO 8601 duration like
  `PT1H`), and optional `resolution`. Answered by a
  history *provider* plugin (signalk-parquet, signalk-to-influxdb2, signalk-questdb, …); with
  none installed you get `501 {"error":"No history api provider configured"}`.
- **A v2 404 can mean "no provider", not "no API".** Provider-backed routes mount per
  provider: with no resources provider, `GET /signalk/v2/api/resources/waypoints` is a plain
  404; enable one and the same URL returns `200 {}`. Autopilot routes behave the same. Only
  some APIs (history) exist unmounted-but-answering with a clean 501. Don't interpret 404 as
  "server too old".
- **Conventions:** `_default` targets the default device (`…/autopilots/_default/engage`),
  `_providers` / `?provider=<id>` targets a specific provider, `_config` addresses API
  configuration. Multi-device and multi-provider APIs all follow these.
- **Auth:** with security disabled, everything is open; with security enabled and
  `allow_readonly` on (the common setup), reads stay anonymous. Writes and protected reads
  need a token: `POST /signalk/v1/auth/login` with
  `{ "username", "password" }`, then send it as a `Bearer` header (REST) or let the cookie
  ride (browser + WebSocket). Everything under `/skServer/*` and `/plugins/*` is **admin** —
  that's server-configuration surface, not data.

## Provider side (server plugins)

- **Feeding the data model *is* the v1 world:** `app.handleMessage(pluginId, { updates:
  [{ values: [{ path, value }] }] })` puts values into the tree and onto the stream, tagged
  with your plugin as `$source`. Emit `meta` updates the same way for units/display hints.
- **Serving a v2 domain means registering a provider, not inventing routes:**
  `app.registerResourceProvider(...)`, `registerAutopilotProvider(...)`,
  `registerWeatherProvider(...)`, `registerHistoryApiProvider(...)` (and
  `registerRadarProvider(...)` for the in-development radar API). Careful with history: plain
  `registerHistoryProvider` is the older, deprecated playback interface — the v2 History API
  wants `registerHistoryApiProvider`. The server mounts the public route, enforces auth, and
  matches the OpenAPI contract; you implement the methods.
  The moment your provider registers, the corresponding `/signalk/v2/api/...` routes go live —
  that's the consumer-visible 404→200 flip above in reverse (history, which stays mounted,
  flips its 501 instead).
- **Never serve consumer data from `registerWithRouter`.** Routes under `/plugins/<id>/*` are
  **admin-gated** (verified on 2.30.0; a route-level access downgrade exists only in
  unreleased master) — every consumer would need an admin token. Data that apps should read
  belongs in the data model (`handleMessage`) or behind a provider registration.
- **Make a path actuatable** with `app.registerPutHandler(context, path, callback)` — the
  callback returns `{ state: 'COMPLETED', statusCode: 200 }` (or `PENDING` now and the result
  later), and consumers reach it through the v1 PUT flow above.
- **Notifications go both ways:** plugins have historically raised alarms as v1 deltas on
  `notifications.<path>` (value with `state`, `method`, `message`); the v2 notifications API
  adds ids, acknowledge/silence, and MOB on top. Raising via deltas remains valid and is what
  most published plugins do.

## Choosing in one breath

Live values in or out → **v1** (deltas / REST tree). Domain operations — courses, waypoints,
alarms, history queries, pilot commands → **v2 as consumer**, provider registration as plugin.
Plugin-private config/UI endpoints → `registerWithRouter` (admin-only by nature). If you find
yourself designing REST routes for boat *data*, stop — the data model or a provider interface
already covers it.

---

*Endpoint behavior, status codes, and response envelopes above verified live against a fresh
released signalk-server **2.30.0** install (Node 24), August 2026 — including the discovery
document's v1-only contents, the resources 404→200 provider flip, the notifications v2 route
surface, the history 501, and the v1 PUT 405 envelope. Provider registration names from the
released `@signalk/server-api` 2.30.0 typings.*
