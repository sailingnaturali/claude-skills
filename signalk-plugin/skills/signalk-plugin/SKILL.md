---
name: signalk-plugin
description: Use when authoring and publishing a SignalK server plugin to npm — the @signalk/server-api patterns that actually work (resource provider vs router, deltas, vessel position), the ESM package scaffold, TypeBox config schemas (which package, and why), webapp state that survives navigation, typechecking a Vite build (Vite only transpiles, so type errors accumulate invisibly), the app icon that 404s because a Vite root disables the default publicDir, the no-install-scripts rule (app-store installs pass --ignore-scripts and npm 12 gates dependency scripts — containerize heavy parts instead), plugin-to-plugin coordination through PropertyValues, metadata for the paths a plugin publishes (units, description, display category, event vs periodic and timeout, so data-timeout enforcement doesn't blank them), and npm OIDC trusted publishing (including the new-package first-publish chicken-and-egg).
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
- Publish a value: `app.handleMessage(plugin.id, { updates: [{ values: [{ path: '<path>' as Path, value }] }] })`. For a path outside the spec, also set its metadata (section 12).
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

An icon at the package root is **not** what the server reads once `public/` exists, and it is
not what the webapp asks for. Something has to put it in the build output.

The trap is that **a Vite `root` kills the default `publicDir`**. Vite resolves `publicDir`
relative to `root`, so the moment the config says `root: 'web'` the default becomes
`web/public` — a directory that usually does not exist. Static assets are then silently copied
from nowhere, and `<link rel="icon" href="/<plugin-id>/icon.svg">` **404s on every page load**
in a real server. Everything functional still works, which is why this survives: the app's JS
and CSS serve 200 and only the icon is missing.

Point `publicDir` at a directory that holds the icon, and keep **one** file there:

```ts
// vite.config.ts
export default defineConfig({
  root: 'web',
  base: '/<plugin-id>/',
  // Copies the icon next to index.html, where both the server's appIcon
  // lookup and the webapp's <link rel="icon"> read it.
  publicDir: '../static',
  build: { outDir: '../public', emptyOutDir: false }
})
```

`outDir` matters as much as `publicDir` here: both are resolved against `root`, so without it
the build lands in `web/dist` and `public/` — the directory `files` ships and the server
mounts — is never written. `emptyOutDir: false` is what lets `public/` also hold things the
build does not generate; the cost is that a renamed or deleted asset lingers there until you
remove it, so set it to `true` if the directory is purely build output.

**Make `static/icon.svg` the real file, not a symlink to a root `icon.svg`.** A symlink
looks like the tidy way to keep one copy, and it builds fine on Linux and macOS, but git on
Windows (where `core.symlinks` is false by default) checks a symlink out as a plain text file
holding its target. Vite then copies that 11-byte file into `public/`, and a release packed from
that checkout ships an "icon" whose content is `../icon.svg`: the App Store card and the
favicon both come up empty, with every other asset serving 200. That is exactly how
signalk-universal-installer-rpi-mgmt 0.1.0 shipped, from a manual first publish on a Windows
machine. With the only copy in `static/`, there is nothing a checkout can turn into a link,
and `files` needs no root `icon.svg`, but it must list `public` (for example `["dist", "public", …]`), because `public/icon.svg` is the one the server and the browser read. A unit test that `lstat`s `static/icon.svg`, asserts it is a regular file, and checks that its content contains `<svg` (an XML declaration may come first) keeps it that way.

Check what you ship with `tar -tvzf <tgz> | grep icon`: `public/icon.svg` must be a regular
file (`-`) with the SVG's real size, not a few bytes.

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
- **Caches → their own subdirectory of the data dir, tagged with a `CACHEDIR.TAG`.** Backups
  copy `getDataDirPath()` along with everything else. A cache the plugin rewrites every few hours
  adds a new copy to every scheduled snapshot. On one boat, a weather router's 4.8 GB of
  caches, almost all rewritten daily, grew the backup repository to 43 GB and filled the cloud
  quota. Put regenerable data (downloads, decoded runs, tiles) in its own subdirectory, and write
  a [cache directory tag](https://bford.info/cachedir/) into it: a file named `CACHEDIR.TAG`
  whose content starts with exactly `Signature: 8a477f597d28d172789f06886806bc55`. Kopia
  (which signalk-backup uses) skips a tagged directory's contents by default. restic, Borg and
  GNU tar skip them with `--exclude-caches`. Getting it right:
  - Write the tag in `start()`, before the first download, so a backup taken meanwhile is
    already clean.
  - Check the file starts with the signature, not just that it exists: tools ignore a tag
    without it.
  - Make your pruners delete only entries named like your own runs, never everything in the
    directory, or the tag goes too.
  - Leave settings, user data and anything that can't be downloaded again offshore (a
    coastline, downloaded charts) untagged, so a restore brings them back.

  *Verified against kopia 0.23.1, October 2026: a tagged directory is stored empty.*
- **Webapp and per-user settings → the applicationData REST API**:
  `/signalk/v1/applicationData/{user|global}/<appid>/<version>`, persisted by the server under
  `<configdir>/applicationData/{users/<name>|global}/<appid>/<version>.json`. `user` scope is
  per logged-in user; the `<version>` segment gives settings-per-app-version for free.
  Gotcha: **with security disabled the whole interface answers 405 "security is not
  enabled"** — a webapp using it must handle that response on open-security servers.
- **Boat data isn't a file at all** — publish it into the data model (`handleMessage`) or
  behind a provider registration, so every consumer sees it through the normal APIs.

## 11. Plugins that coordinate: PropertyValues

When one plugin has to tell another something — "I evaluate collision alarms for radar
targets, stand your own down", or "here is a parser for my custom sentence" — use the
server's **PropertyValues**: `app.emitPropertyValue(name, value)` and
`app.onPropertyValues(name, cb)`. They are on every plugin's `app`, typed in
`@signalk/server-api`.

- **Not a property on `app`.** Each plugin gets its own shallow copy of `app`, so a field one
  plugin sets there is invisible to every other. A `globalThis` field is visible but gives the
  other side nothing to react to, and the server can't see it.
- **Not for data.** Measurements and state that change belong in deltas (`handleMessage`).
  PropertyValues are for configuration-type announcements.
- **The whole history is kept, and the cap is server-wide.** Every emit is appended and never
  trimmed. The server allows 1000 values across *all* names together (each name's initial
  `undefined` counts, added on the first emit *or subscribe* to that name, so subscribing uses
  the budget too; the check runs before the emit, so a first emit under a new name at 999
  still lands, at 1001), and then `emitPropertyValue` throws. So emit on changes only — never on
  a timer, per delta, or per request — or one chatty plugin breaks every other plugin's emits.
- **The callback gets the history, not a value.** `onPropertyValues` calls back at once with
  the full array, which always starts with `undefined` (so the first call may be just
  `[undefined]`), and again on every later emit. For a state one plugin owns (like the
  example below) the last element is the current value. For a name several plugins contribute
  to, like `nmea0183sentenceParser`, every element counts: walk the whole history, skipping
  the `undefined`. There is no plugin start order, so a value may already be there or arrive
  later — react on every call, don't read once in `start()`.
- **Nothing is withdrawn on stop.** A plugin that announces a state it alone owns in `start()`
  emits the opposite in `stop()`, and the listener calls the returned unsubscribe in its
  `stop()`. That withdrawal is best effort: at the cap the emit throws and listeners keep the
  old state, so they must cope with a stale announcement. A contribution to a name several
  plugins share — a parser under `nmea0183sentenceParser` — can't be taken back by a later
  value at all; it stays until the server restarts, unless the name defines its own retraction.
- **Any plugin can emit under any name.** Pick a name that names your plugin or feature, and
  check the shape of what you receive instead of casting. (`value` may also be a function — that
  is how `nmea0183sentenceParser` lets a plugin add parsers for custom sentences.)

```ts
// announcing plugin
const PROPERTY = 'collisionAlerts'
let announced = false
function announce(running: boolean): void {
  if (running === announced) return // history is never trimmed: emit changes only
  try {
    app.emitPropertyValue(PROPERTY, { evaluatesTargets: running })
    announced = running
  } catch (error) {
    // the server-wide cap is reached; a throw must not break start() or stop()
    app.error(`Could not announce ${PROPERTY}: ${String(error)}`)
  }
}
// start: announce(true)   stop: announce(false)

// listening plugin
let unsubscribe: (() => void) | undefined
let collisionAlertsRunning = false
// in start():
unsubscribe = app.onPropertyValues(PROPERTY, (history) => {
  const v = history[history.length - 1]?.value
  collisionAlertsRunning =
    typeof v === 'object' && v !== null &&
    (v as { evaluatesTargets?: unknown }).evaluatesTargets === true
})
// in stop():
unsubscribe?.()
unsubscribe = undefined
```

*History, the `[undefined]` first call, unsubscribe and the server-wide 1000-value cap
verified against `@signalk/server-api` 2.35.0, October 2026; the per-plugin `app` copy against
signalk-server 2.35.1 `src/interfaces/plugins.ts`.*

## 12. Metadata for the paths you publish

A path that is not in the Signal K specification arrives with no metadata: no unit, no
description, no idea whether silence means "lost" or "unchanged". Other apps can't build on
it, and once the server enforces data timeouts it may blank the value. Give every path you
publish outside the spec — and a spec path whose defaults are wrong for your data — its
metadata with `app.setDefaultMetadata(path, meta)` in `start()`:

- **`units`** (SI: `m`, `s`, `K`, `rad`, `m/s`, `ratio`, …) and **`description`**, so clients
  can convert and label the value and other plugin authors know what it is.
- **`displayUnits: { category }`** when the unit alone picks the wrong display category.
  Without a category the server picks one from the unit, and for `m` that is distance: tide
  heights then show in nautical miles in the nautical presets (a 0.5 m tide reads
  "0.0 nmi"). A water level belongs in `depth`.
- **How staleness should treat it** — only matters for numbers and objects; string and
  boolean values are never timed out:
  - `updateContract: 'event'` for a value you send only when it changes (a state, a
    setting, a computed result that stays put). Silence then means "unchanged", never stale.
  - `updateContract: 'periodic'` for a value you send on a schedule. That is the default, so
    you can usually leave it out — but the server treats some prefixes as event data
    (`navigation.anchor`, `navigation.course`, `navigation.home`, `design`,
    `communication`, …): a periodic value there is never timed out, even with a
    `timeout`, unless you say so.
  - a periodic path's **`timeout`**, in seconds: a few times your publish interval, or `0`
    to exempt it. Without one the spec's timeout applies, else the server's default, 60 s
    out of the box — a value published every 60 s then can time out just before each
    update.
  - `timeout: 'auto'` lets the server learn the rate, but during its warm-up (up to 30 s,
    and at least two updates) it uses the server's default, and it never learns more than 300 s.
    For a value sent less often than once a minute, give a number instead.

```ts
import type { MetaValue } from '@signalk/server-api'

const PATH_META: Record<string, MetaValue> = {
  'environment.tide.timeToNextExtreme': {
    units: 's',
    description: 'Seconds until the next tide extreme (high or low water)',
    timeout: 180 // published every 60 s
  },
  // a spec path: unit and description come from the spec, the category does not
  'environment.tide.heightNow': {
    displayUnits: { category: 'depth' } as MetaValue['displayUnits']
  }
}

// in start(), not awaited: it writes a file, and nothing else depends on it
void (async () => {
  if (typeof app.setDefaultMetadata !== 'function') return // server < 2.30
  for (const [path, meta] of Object.entries(PATH_META)) {
    try {
      await app.setDefaultMetadata(path, meta)
    } catch (error) {
      app.error(`Could not set metadata for ${path}: ${String(error)}`)
    }
  }
})()
```

- **Not a `meta` entry in your deltas.** `handleMessage` with `updates: [{ meta: [...] }]`
  reaches clients, but the timeout enforcer never reads it: it looks only at stored metadata
  (what the user set in the Data Browser, and `setDefaultMetadata`) and at the spec's own
  timeouts. A meta delta is also gone after a restart until you send it again.
- **The user wins, per field.** `setDefaultMetadata` stores only fields the path does not
  have yet and never overwrites them, so a user's own `timeout` or display unit survives
  your plugin. The flip side: a value you change in a later release does not reach a server
  that already stored the old one.
- **A rejected category drops the whole call.** `displayUnits.category` is checked against
  the path's SI unit (from your `units`, the stored meta or the spec). On a mismatch nothing
  is stored — not the `description` or `timeout` in the same call either — and the reason
  goes only to the server's debug log. The method returns `false`, as it also does when every
  field already exists.
- **`MetaValue` types `displayUnits` as the server resolves it** (target unit, formulas,
  symbol). A suggestion needs only the category, hence the cast in the example.

*`setDefaultMetadata` (server 2.30.0+) and the timeout enforcer (2.31.0+, off unless the user
enables Enforce Data Timeouts, applied to `vessels.self` only) verified against
signalk-server 2.35.1 `src/interfaces/plugins.ts`, `src/staleness.ts` and
`src/unitpreferences/resolver.ts`, October 2026. The tide-height category from
[openwatersio/signalk-tides#179](https://github.com/openwatersio/signalk-tides/pull/179).*

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
