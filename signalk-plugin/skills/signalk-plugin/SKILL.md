---
name: signalk-plugin
description: Use when authoring and publishing a SignalK server plugin to npm — the @signalk/server-api patterns that actually work (resource provider vs router, deltas, vessel position), the ESM package scaffold, TypeBox config schemas, webapp state that survives navigation, the no-install-scripts rule (app-store installs pass --ignore-scripts and npm 12 gates dependency scripts — containerize heavy parts instead), and npm OIDC trusted publishing (including the new-package first-publish chicken-and-egg).
---

# Author & publish a SignalK plugin

Hard-won notes for building a [SignalK](https://signalk.org) Node-server plugin and shipping
it to npm. Mirror a clean reference: [`openwatersio/signalk-tides`](https://github.com/openwatersio/signalk-tides)
(TypeScript) is the best one to read for the `@signalk/server-api` calls.

## 1. Scaffold

Public repo, npm package, MIT, **zero runtime deps where possible**. Files: `index.js` (or
TS `src/` built with `tsc`), `package.json`, `LICENSE`, `README.md`, `.gitignore`
(`node_modules`, `*.tgz`), tests (`index.test.js` via `node:test`, or `test/` via `vitest`),
`.github/workflows/{test.yml,publish.yml}`.

`package.json` essentials — a missing `files` ships *nothing* because `.gitignore` excludes the build:
```json
{
  "name": "signalk-<name>",
  "type": "module",
  "files": ["index.js"],
  "keywords": ["signalk-node-server-plugin", "signalk-category-utility"],
  "license": "MIT"
}
```
For a scoped package add `"publishConfig": { "access": "public" }`. For TypeScript use
`"files": ["dist"]` and `"prepare": "npm run build"` so `npm publish` builds first. The
`signalk-node-server-plugin` keyword is what surfaces it in the SignalK app store.

## 2. Write new plugins as ESM

Prefer `"type": "module"` over CJS for anything new. The server has loaded ESM plugins since
**v2.14.0** (June 2025): it `require()`s the plugin directory first — Node ≥ 20.19 / ≥ 22.12
loads ESM through `require` by default — and falls back to dynamic `import()` resolved via
`esm-resolve` (plain `import()` can't take a directory path), so ESM plugins load even on Nodes
where `require(esm)` isn't available. (Server 2.30.0 itself requires Node ≥ 22; v2.14.0
required ≥ 20.) Both paths unwrap `mod.default ?? mod`, so the entry point must
**`export default function (app) { ... }`** returning the plugin object. The practical reason
to switch: new majors of common dependencies ship ESM-only, and a CJS plugin can only reach
those through awkward dynamic `import()` — an ESM plugin just imports them. For TypeScript,
`"module": "nodenext"` with a default export compiles to the same shape — remember nodenext
makes relative imports require explicit `.js` extensions (`./helpers.js`, even in `.ts` files).

## 3. The @signalk/server-api patterns that actually work

- **Serve plugin data via `app.registerResourceProvider({ type, methods: { listResources, getResource, setResource, deleteResource } })`** — it's served at `/signalk/v2/api/resources/<type>` and is **anonymously readable** under the server's `allow_readonly`. **Do NOT serve data with `registerWithRouter`** — `/plugins/<id>/*` routes are **admin-gated**, so every consumer would need an admin token. This is the single biggest gotcha.
- Publish a value: `app.handleMessage(plugin.id, { updates: [{ values: [{ path: '<path>' as Path, value }] }] })`.
- Read the vessel position: `app.getSelfPath('navigation.position.value') as Position | undefined` (note the `.value` suffix).
- Do periodic work in `setInterval`, and wrap each cycle — and each independent step inside it — in `try/catch` → `app.error(...)`, so one failing fetch can't blank everything else or kill the loop.
- **Avoid an `express` runtime dependency**: register routes on the `IRouter` the server hands you via `registerWithRouter`, or use the resource API; keep `@types/express` dev-only via `import type` (erased at build).

### Define the config schema once, in TypeBox

`@signalk/server-api` ships `@sinclair/typebox` and exports SignalK domain schemas at
`@signalk/server-api/typebox` (course, notifications, resources, weather, …). TypeBox types
*are* JSON Schema objects at runtime, so one definition is both the admin-UI config form and
the TypeScript type:

```ts
import { Type, type Static } from '@sinclair/typebox'

const ConfigSchema = Type.Object({
  stationName: Type.String({ title: 'Station name', default: 'my-station' }),
  intervalSeconds: Type.Number({ title: 'Poll interval (s)', default: 60, minimum: 5 }),
  alerts: Type.Optional(Type.Boolean({ title: 'Enable alerts' }))
})
type Config = Static<typeof ConfigSchema> // the type of start(config)

// in the plugin object:  schema: () => ConfigSchema
```

Declare `@sinclair/typebox` in the plugin's **own `dependencies`** — don't rely on the server's
copy being hoisted into reach. The admin UI renders `title`/`description`/`default` as-is. Two
gotchas: every property not wrapped in `Type.Optional(...)` lands in the schema's `required`
list, so wrap truly optional fields; and the package is the **scoped `@sinclair/typebox`**
(0.34.x — what server-api uses). The *unscoped* `typebox` on npm is the separate 1.x line with
a different API — don't mix them.

## 4. Plugin webapp state: a store, not `useState`

If the plugin ships a webapp or an embedded config panel, keep view state that must survive
navigation — active tab, filter, sort order, selection — in a small store rather than component
`useState`. Components unmount on route round-trips (open a detail view, navigate back) and
`useState` silently resets to defaults, which users read as "my selection got lost"; store
state survives the remount. Use **Zustand** — it's what the server's own admin UI uses (v5),
so you add no new concept to the stack — and this exact bug class has shipped in the admin UI
itself, so treat it as the default trap, not an edge case.

## 5. Publish to npm

Ship via **OIDC trusted publishing** so each GitHub release auto-publishes with no token/OTP.
The full flow — the release-triggered `publish.yml`, the new-package first-publish
chicken-and-egg (CLI+OTP once, then configure the trusted publisher), and the
registry-propagation 404 gotcha — is in the **`npm-oidc-publish`** skill in this marketplace.
SignalK-specific bits: the `signalk-node-server-plugin` keyword is what surfaces the package
in the app store, and ship `index.js`/`dist` via `"files"`.

## 6. Install on a SignalK server

Install from the admin UI **Appstore** (search your plugin), or `npm install signalk-<name>`
in the server's data dir (`~/.signalk`), then restart. Config persists under
`~/.signalk/plugin-config-data/`. If the server runs in Docker and you develop locally,
**never bind-mount a plugin inside `node_modules`** — the app store reifies that tree with npm
and can't rename a mount point (`EBUSY`), which breaks *every* plugin install/update. Mount
outside `node_modules` and link it with a `file:` dep, or just `npm install` it as a tracked
dependency (anything extraneous gets pruned on the next reify).

## 7. Install scripts never run — design for it

- **The app store installs plugins with `npm --save --ignore-scripts install`** (read from the
  released server's install path). Your plugin's `install`/`postinstall` — and those of every
  dependency — are skipped on every app-store install. (`"prepare": "npm run build"` from the
  scaffold is unaffected: it runs on *your* machine at publish, not on the user's at install.)
- **npm 12 extends the same to manual installs**: `latest` since July 2026, it skips dependency
  lifecycle scripts by default with only a `npm warn install-scripts` hint — and a plugin
  *cannot whitelist itself*, because `allowScripts` is honored only in the install **root**'s
  package.json, never in a dependency's own.
- **The failure mode is silent.** The install "succeeds"; the missing build artifact surfaces
  only at runtime ("Failed to load native canSocket module" — the `node-gyp rebuild`-in-postinstall
  class of breakage that hit every server image when npm moved 11→12).
- So: **no load-bearing install scripts anywhere in your dependency tree.** Prefer pure JS;
  where native is unavoidable, use N-API prebuilds resolved at `require` time (the serialport
  pattern — it kept working throughout). CI check that costs nothing: install your plugin with
  `npm install --ignore-scripts` and run the tests against that tree.
- **Need more than a script-free npm package can deliver** — a native toolchain, real compute,
  an external service? Don't fight the constraint: ship that part as a **container** your
  plugin manages through the [signalk-container](https://github.com/dirkwa/signalk-container)
  manager (the [`signalk-container-helper`](https://github.com/hoeken/signalk-container-helper)
  library packages the container lifecycle), and keep the npm plugin itself thin.

## 8. Where to store what

Four distinct places, and picking the wrong one is a delayed-loss bug:

- **Never inside the plugin's install directory** (`__dirname`, anywhere under
  `node_modules`). The app store reinstalls/reifies that tree on every update — files written
  there silently vanish. This is the classic "worked for months, gone after an update" report.
- **Plugin configuration → let the server own it.** What the user sets in the config form
  arrives as `start(config)`; the server persists it at
  `<configdir>/plugin-config-data/<pluginid>.json`. Update it programmatically via
  `app.savePluginOptions(...)` — never write that file yourself.
- **Plugin runtime data → `app.getDataDirPath()`**, which is the per-plugin directory
  `<configdir>/plugin-config-data/<pluginid>/`. It survives plugin updates and travels with
  the server's config dir (and its backups). This is where caches, downloaded files, and
  databases belong — the bundled resources-provider keeps its waypoints/routes there.
- **Webapp and per-user settings → the applicationData REST API**:
  `/signalk/v1/applicationData/{user|global}/<appid>/<version>`, persisted by the server under
  `<configdir>/applicationData/{users/<name>|global}/<appid>/<version>.json`. `user` scope is
  per logged-in user; the `<version>` segment gives settings-per-app-version for free.
  Gotcha: **with security disabled the whole interface answers 405 "security is not
  enabled"** — a webapp using it must handle that response on open-security servers.
- **Boat data isn't a file at all** — publish it into the data model (`handleMessage`) or
  behind a provider registration, so every consumer sees it through the normal APIs.

## Testing

Keep pure helpers (parsing, mapping, math) separate and test them directly; inject/mock the
I/O boundary (HTTP fetches, the SignalK `app.*` calls), or exercise it against a throwaway
local `http` server in the test. `node:test` for JS, `vitest` for TS.

---

*ESM loading (via the `require` path on Node 24) and the TypeBox config form — render, save,
`start(config)`, delta emission — verified end-to-end against signalk-server 2.30.0 /
`@signalk/server-api` 2.30.0, August 2026. The ESM loader mechanics are from the server's
`importOrRequire` in `src/modules.ts`.*
