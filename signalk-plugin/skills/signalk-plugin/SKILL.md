---
name: signalk-plugin
description: Use when authoring and publishing a SignalK server plugin to npm — the @signalk/server-api patterns that actually work (resource provider vs router, deltas, vessel position), the package scaffold, and npm OIDC trusted publishing (including the new-package first-publish chicken-and-egg).
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
  "files": ["index.js"],
  "keywords": ["signalk-node-server-plugin", "signalk-category-utility"],
  "license": "MIT"
}
```
For a scoped package add `"publishConfig": { "access": "public" }`. For TypeScript use
`"files": ["dist"]` and `"prepare": "npm run build"` so `npm publish` builds first. The
`signalk-node-server-plugin` keyword is what surfaces it in the SignalK app store.

## 2. The @signalk/server-api patterns that actually work

- **Serve plugin data via `app.registerResourceProvider({ type, methods: { listResources, getResource, setResource, deleteResource } })`** — it's served at `/signalk/v2/api/resources/<type>` and is **anonymously readable** under the server's `allow_readonly`. **Do NOT serve data with `registerWithRouter`** — `/plugins/<id>/*` routes are **admin-gated**, so every consumer would need an admin token. This is the single biggest gotcha.
- Publish a value: `app.handleMessage(plugin.id, { updates: [{ values: [{ path: '<path>' as Path, value }] }] })`.
- Read the vessel position: `app.getSelfPath('navigation.position.value') as Position | undefined` (note the `.value` suffix).
- Provide a config `schema` (an object, or `() => ({...})`). Do periodic work in `setInterval`, and wrap each cycle — and each independent step inside it — in `try/catch` → `app.error(...)`, so one failing fetch can't blank everything else or kill the loop.
- **Avoid an `express` runtime dependency**: register routes on the `IRouter` the server hands you via `registerWithRouter`, or use the resource API; keep `@types/express` dev-only via `import type` (erased at build).

## 3. npm OIDC trusted publishing (no tokens/OTP after the first release)

`.github/workflows/publish.yml`:
```yaml
name: publish
on: { release: { types: [published] } }
permissions: { contents: read, id-token: write } # npm trusted publishing (OIDC)
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci          # needs a committed package-lock.json (run `npm install` once)
      - run: npm test
      - run: npm publish
```
- **A brand-new package can't publish via OIDC on the first try** — npm won't let you configure a trusted publisher for a package that doesn't exist yet. So publish `0.1.0` **once via the CLI** (`npm publish` → enter your 2FA OTP), *then* on npmjs.com → the package → Settings → **Trusted Publisher** → GitHub Actions: your repo + workflow filename `publish.yml` + blank environment.
- After that, every release publishes hands-free: `gh release create vX.Y.Z --notes "..."`.
- npm's public registry metadata lags a few minutes for a new scoped package — the npmjs.com website shows it first, so a `npm view` / registry GET returning 404 right after a successful `+ <pkg>@<ver>` is just propagation, not a failure.

## 4. Install on a SignalK server

Install from the admin UI **Appstore** (search your plugin), or `npm install signalk-<name>`
in the server's data dir (`~/.signalk`), then restart. Config persists under
`~/.signalk/plugin-config-data/`. If the server runs in Docker and you develop locally,
**never bind-mount a plugin inside `node_modules`** — the app store reifies that tree with npm
and can't rename a mount point (`EBUSY`), which breaks *every* plugin install/update. Mount
outside `node_modules` and link it with a `file:` dep, or just `npm install` it as a tracked
dependency (anything extraneous gets pruned on the next reify).

## Testing

Keep pure helpers (parsing, mapping, math) separate and test them directly; inject/mock the
I/O boundary (HTTP fetches, the SignalK `app.*` calls), or exercise it against a throwaway
local `http` server in the test. `node:test` for JS, `vitest` for TS.
