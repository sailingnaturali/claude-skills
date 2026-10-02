---
name: signalk-plugin
description: Use when authoring and publishing a SignalK server plugin to npm — the @signalk/server-api patterns that actually work (resource provider vs router, deltas, vessel position), the ESM package scaffold, TypeBox config schemas (which package, and why), webapp state that survives navigation, typechecking a Vite build (Vite only transpiles, so type errors accumulate invisibly), the app icon that 404s because a Vite root disables the default publicDir, the no-install-scripts rule (app-store installs pass --ignore-scripts and npm 12 gates dependency scripts — containerize heavy parts instead), and npm OIDC trusted publishing (including the new-package first-publish chicken-and-egg).
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
`"files": ["dist"]`, point `"main": "dist/index.js"` (and `"types": "dist/index.d.ts"`) at the
build output — without `main` the server resolves a nonexistent root `index.js` — and add
`"prepare": "npm run build"` so `npm publish` builds first. The
`signalk-node-server-plugin` keyword is what surfaces it in the SignalK app store.

## 2. Write new plugins as ESM

Prefer `"type": "module"` over CJS for anything new. The server has loaded ESM plugins since
**v2.14.0** (June 2025): it `require()`s the plugin directory first — Node ≥ 20.19 / ≥ 22.12
loads ESM through `require` by default — and falls back to dynamic `import()` resolved via
`esm-resolve` (plain `import()` can't take a directory path), so ESM plugins load even on Nodes
where `require(esm)` isn't available. (Server 2.30.0 itself requires Node ≥ 22; v2.14.0
required ≥ 20.) The `require` path unwraps `mod.default ?? mod`; the `import()` fallback
returns `module.default` *directly* — anything without one loads as `undefined` there. So the
entry point must **`export default function (app) { ... }`** returning the plugin object. The practical reason
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

`@signalk/server-api` exports SignalK domain schemas at `@signalk/server-api/typebox` (course,
notifications, resources, weather, …). TypeBox types *are* JSON Schema objects at runtime, so
one definition is both the admin-UI config form and the TypeScript type — pick your TypeBox
package first (see below; for a new ESM plugin it's the unscoped `typebox`):

```ts
import { Type, type Static } from 'typebox'

const ConfigSchema = Type.Object({
  stationName: Type.String({ title: 'Station name', default: 'my-station' }),
  intervalSeconds: Type.Number({ title: 'Poll interval (s)', default: 60, minimum: 5 }),
  alerts: Type.Optional(Type.Boolean({ title: 'Enable alerts' }))
})
type Config = Static<typeof ConfigSchema> // the type of start(config)

// in the plugin object:  schema: () => ConfigSchema
```

**Which TypeBox: use unscoped `typebox` 1.x for a new ESM plugin.** There are two packages,
and the difference is a module-format constraint on the *server*, not a recommendation for you:

- **`typebox` (unscoped, 1.x)** — the current line and the future. It is **exports-only ESM**
  with no `main`, which is what keeps the still-CJS server and its `node10`-style TypeScript
  resolution off it.
- **`@sinclair/typebox` (scoped, 0.34.x)** — what `@signalk/server-api` depends on, because the
  server is still CJS. It will migrate to 1.x once the legacy JS is refactored to strict TS.

**They emit the same JSON Schema**, so the admin UI cannot tell them apart — verified by
building the same `Type.Object` under both and comparing: identical keys and values, differing
only in key insertion order, which no JSON Schema consumer cares about. Since the schema
crosses the plugin/server boundary as plain JSON, not as a TypeBox object, the server's own
version does not constrain yours. Write new ESM plugins against 1.x and you are already on the
line the server is heading for.

What you must not do is import `Type`/`Static` from **both** packages in one file: the two
APIs are separate, and a `Static<>` taken from one line over a schema built by the other is
where it breaks. Nesting server-api's exported domain schemas as plain **values** inside a
1.x `Type.Object` is fine and emits the same JSON Schema — verified by building the same
object with a 0.34 schema nested under both lines.

Declare your TypeBox package in the plugin's **own `dependencies`** — don't rely on the
server's copy being hoisted into reach. (If you still ship a CJS plugin, stay on scoped
0.34.x — not because 1.x fails at runtime, since Node ≥ 22.12 will `require()` an ESM package,
but because 1.x is exports-only with no `main`, so a TypeScript project on
`moduleResolution: node10`/`node` cannot resolve it.) The admin UI renders `title`/`description`/`default` as-is.
One further gotcha: every property not wrapped in `Type.Optional(...)` lands in the schema's
`required` list, so wrap truly optional fields.

## 4. Plugin webapp state: a store, not `useState`

If the plugin ships a webapp or an embedded config panel, keep view state that must survive
navigation — active tab, filter, sort order, selection — in a small store rather than component
`useState`. Components unmount on route round-trips (open a detail view, navigate back) and
`useState` silently resets to defaults, which users read as "my selection got lost"; store
state survives the remount. Use **Zustand** — it's what the server's own admin UI uses (v5),
so you add no new concept to the stack — and this exact bug class has shipped in the admin UI
itself, so treat it as the default trap, not an edge case.

## 5. Vite transpiles — it does not typecheck

A Vite build strips types and emits; it never runs the typechecker. So a webapp or config
panel written in TypeScript can build green for months while type errors pile up invisibly,
and `strict` in `tsconfig.json` buys you nothing at build time — only your editor sees those
errors, and only for files you happen to open.

This is not theoretical: the SignalK server's own admin UI had accumulated **40 type errors**
under an otherwise strict config before anyone ran `tsc --noEmit` against it. Three were real
user-visible defects, not annotation noise — a `<Col xs="0">` emitting a nonexistent `col-0`
class, a `size={5}` on a react-bootstrap `Form.Control` that silently did nothing (`htmlSize`
is the prop that sets input width), and a test asserting a payload shape the store never
produced, because the store redeclared the type inline instead of importing the shared one.

Add [`vite-plugin-checker`](https://github.com/fi3ework/vite-plugin-checker) so the build
typechecks and fails on any new error:

```ts
// vite.config.ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import checker from 'vite-plugin-checker'

// `__dirname` does not exist in an ESM config, and the whole point here is
// an absolute path that does not depend on the cwd the build runs from.
const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    // Pin the project explicitly -- `typescript: true` is a silently
    // vacuous gate on most scaffolds. See below.
    checker({ typescript: { root: here, buildMode: true } })
  ]
})
```

```json
"devDependencies": { "vite-plugin-checker": "^0.14.5", "typescript": "^5.9.3" }
```

Notes that matter in practice:

- **`typescript: true` is not enough — pin the project.** The bare form is what makes this a
  placebo instead of a gate, in two ways.

  *Dev and build resolve different tsconfigs.* Dev mode resolves from the **Vite root**, but
  build mode spawns a bare `tsc --noEmit` from **`process.cwd()`** (`buildBin` returns
  `['tsc', ['--noEmit']]` with no `-p`, and the spawn uses `cwd: process.cwd()`). For the
  plugin shape this skill teaches — server TS in `src/`, webapp in a subdirectory — `npm run
  build` at the package root runs the webapp's check against the **plugin's** tsconfig. The
  webapp's errors are never looked at. signalk-server escapes this only because its
  `vite build` is invoked from `packages/server-admin-ui/`, where cwd and the Vite root
  coincide.

  *A solution-style tsconfig checks nothing.* `npm create vite@latest -- --template react-ts`
  generates a root `tsconfig.json` of `{ "files": [], "references": [...] }`. Bare
  `tsc --noEmit` against that typechecks **zero files and exits 0** — TypeScript suppresses
  TS18003 for solution configs. Verified with typescript 5.9.3 and a real error in `src/`:
  `tsc --noEmit` exits 0, `tsc -b` reports TS2322 and exits 1.

  Passing an object fixes both: `root` pins the project for build mode
  (`buildBin` then emits `-p <root>/<tsconfigPath>`), and `buildMode: true` runs `tsc -b`,
  which follows project references. An explicit `tsconfigPath` works in place of
  `buildMode` when the config is flat.
- **Dev and build both report, once pinned.** `enableBuild`, `overlay` and `terminal` all
  default to `true`, so `vite build` fails on a type error and `vite dev` shows it as an
  overlay plus terminal output.
- **Budget the build time.** Typechecking is not free: the admin UI build went from about
  30s to about 38s. That is the whole cost, and it is worth it.
- **Fix the backlog before you add the gate**, not after — otherwise the first build after
  wiring it up fails on errors that predate you. Clear it with the same project-aware command
  the gate will run — `tsc -b <tsconfig>` where there are project references, `tsc --noEmit -p
  <tsconfig>` for a flat one — get to zero, then add the plugin in the same change so it can
  never regress. A bare `tsc --noEmit` here would under-report for the reasons above and leave
  you thinking the backlog was already clear.
- **Verify the gate actually bites.** Introduce a deliberate type error and confirm the build
  exits non-zero. A checker that is silently misconfigured looks exactly like a clean codebase
  — and per the two traps above, the misconfigured spelling is the one most readers reach for
  first, so this step is the whole difference between a gate and a placebo.

`vitest` does not close this gap by default either — it runs tests through the same
transpile-only pipeline, so a test file can reference a type that does not exist and still
pass. It has a `--typecheck` mode (`typecheck.enabled`), off by default, but that checks test
files on a test run; it is not a substitute for the build-time gate.

*The two `typescript: true` traps were verified against vite-plugin-checker 0.14.5's
`buildBin` and spawn (`cwd: process.cwd()`), and the solution-config exit-0 reproduced with
typescript 5.9.3. Verified against vite 8 / vite-plugin-checker 0.14.5, September 2026 — SignalK/signalk-server
[#3068](https://github.com/SignalK/signalk-server/pull/3068).*

## 6. The app icon: one file, two consumers

`signalk.appIcon` in `package.json` is resolved against the plugin's **served root**, and the
server picks that root by looking for a `public/` directory: `getInstalledServedRoot` in
`src/appstore/local-assets.ts` returns `<pkg>/public` when that directory exists and falls
back to `<pkg>` when it does not. So the moment a plugin ships a webapp, `appIcon:
"./icon.svg"` means `public/icon.svg` — the same place the webapp's own
`<link rel="icon">` fetches from. One file, one location, two consumers.

Keeping the authored icon at the package root is still convenient (it is what a reader of the
repo expects), but it is **not** what the server reads once `public/` exists, and it is not
what the webapp asks for. Something has to put it in the build output.

The trap is that **a Vite `root` kills the default `publicDir`**. Vite resolves `publicDir`
relative to `root`, so the moment the config says `root: 'web'` the default becomes
`web/public` — a directory that usually does not exist. Static assets are then silently copied
from nowhere, and `<link rel="icon" href="/<plugin-id>/icon.svg">` **404s on every page load**
in a real server. Everything functional still works, which is why this survives: the app's JS
and CSS serve 200 and only the icon is missing.

Point `publicDir` at a directory that holds the icon, and keep **one** file:

```ts
// vite.config.ts
export default defineConfig({
  root: 'web',
  base: '/<plugin-id>/',
  // The authored icon lives at the package root; both the server's appIcon
  // lookup and the webapp's <link rel="icon"> read it from the build output.
  // Copy it at build time rather than keeping a second copy in step by hand.
  publicDir: '../static',
  build: { outDir: '../public', emptyOutDir: false }
})
```

`outDir` matters as much as `publicDir` here: both are resolved against `root`, so without it
the build lands in `web/dist` and `public/` — the directory `files` ships and the server
mounts — is never written. `emptyOutDir: false` is what lets `public/` also hold things the
build does not generate; the cost is that a renamed or deleted asset lingers there until you
remove it, so set it to `true` if the directory is purely build output.

Create `static/icon.svg` as a symlink to the root `icon.svg`, so there is one real file. A
second *copy* works too and is what several plugins do, but then the two drift the first time
the icon is redrawn.

**Ship the build output, not the symlink directory.** `files` lists the icon and the build
output (`["dist", "public", "icon.svg", …]`) — `static/` stays out of the package, because
`vite build` has already copied the real bytes into `public/`. Shipping the root copy too is
harmless and keeps the repo layout honest; `public/icon.svg` is the one the server and the
browser actually read. That distinction is what makes
the symlink safe: npm 12 silently drops a symlinked file from a packed directory, so a
package that shipped `static/` itself would publish without it and 404 exactly as before.

This was checked on Vite 8.3, where `vite build` follows a file symlink in `publicDir` and
copies the real bytes. The dev server has had its own history with symlinked static files, so
if `npm run dev` serves the icon differently from the build, keep a real copy rather than
debugging it. Verified on npm 12 against a
plugin built this way: `vite build` writes the real 1052 bytes to
`public/icon.svg` (not a link), and `npm pack` produces `package/icon.svg` and
`package/public/icon.svg` as regular files. Check yours with `tar -tvf <tgz> | grep icon` —
a link shows as `l`, a real file as `-`.

Then install the tarball into a running server and fetch the icon path itself. A plugin that
has never been installed from its tarball has never had this path exercised: everything
functional serves 200, so nothing else tells you.

## 7. Publish to npm

Ship via **OIDC trusted publishing** so each GitHub release auto-publishes with no token/OTP.
The full flow — the release-triggered `publish.yml`, the new-package first-publish
chicken-and-egg (CLI+OTP once, then configure the trusted publisher), and the
registry-propagation 404 gotcha — is in the **`npm-oidc-publish`** skill in this marketplace.
SignalK-specific bits: the `signalk-node-server-plugin` keyword is what surfaces the package
in the app store, and ship `index.js`/`dist` via `"files"`.

## 8. Install on a SignalK server

Install from the admin UI **Appstore** (search your plugin), or `npm install signalk-<name>`
in the server's data dir (`~/.signalk`), then restart. Config persists under
`~/.signalk/plugin-config-data/`. If the server runs in Docker and you develop locally,
**never bind-mount a plugin inside `node_modules`** — the app store reifies that tree with npm
and can't rename a mount point (`EBUSY`), which breaks *every* plugin install/update. Mount
outside `node_modules` and link it with a `file:` dep, or just `npm install` it as a tracked
dependency (anything extraneous gets pruned on the next reify).

## 9. Install scripts never run — design for it

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

## 10. Where to store what

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
local `http` server in the test. `node:test` for JS, `vitest` for TS — but note that `vitest` transpiles without typechecking too, so it is no substitute for the build-time gate in section 5.

---

*ESM loading (via the `require` path on Node 24) and the TypeBox config form — render, save,
`start(config)`, delta emission — verified end-to-end against signalk-server 2.30.0 /
`@signalk/server-api` 2.30.0, August 2026, **with the scoped `@sinclair/typebox` 0.34
sample**. For unscoped `typebox` 1.x only the schema equivalence was checked (same JSON
Schema modulo key order, including a 0.34 schema nested as a value); that admin-UI run has
not been repeated against a 1.x sample. The ESM loader mechanics are from the server's
`importOrRequire` in `src/modules.ts`. The `typebox` 1.x / `@sinclair/typebox` 0.34 schema
equivalence was re-checked against typebox 1.3.34 and @sinclair/typebox 0.34.52, September 2026.*
