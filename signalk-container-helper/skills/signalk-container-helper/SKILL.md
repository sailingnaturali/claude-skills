---
name: signalk-container-helper
description: Use when building a SignalK server plugin that runs a Docker/Podman container through the signalk-container manager — the signalk-container-helper library that packages the container lifecycle (wait for the manager, validate the tag, self-heal, ensureRunning, wait for HTTP readiness, wire update routes, stop cleanly) and the shared React config-panel building blocks, so you stop hand-writing the same integration glue.
---

# Build a containerized SignalK plugin with signalk-container-helper

Containerized SignalK plugins all hand-write the same glue: poll for the container manager,
validate the image tag, call `ensureRunning`, wait for the app inside the container to answer
HTTP, register for update detection, mount update routes, and stop cleanly.
[`signalk-container-helper`](https://github.com/hoeken/signalk-container-helper) packages those
patterns — extracted from `signalk-backup`, `mayara-server-signalk-plugin`, `signalk-doctor`,
and `signalk-updater` — into one typed, zero-dependency API. It sits on top of the
[`signalk-container`](https://github.com/dirkwa/signalk-container) manager plugin (which does
the actual podman/docker work). Use this skill when a plugin needs to run a container; don't
re-implement the lifecycle by hand.

## 0. Wiring & constraints (get these right first)

- **ESM only, Node ≥ 24.** The library ships as an ES module (`import`, not `require`); your
  plugin must be ESM too.
- **Runtime-only coupling — never add `signalk-container` to `dependencies`.** Its prerelease
  versioning breaks npm semver ranges. Declare the relationship instead, and the library reaches
  the manager through a runtime global:
  ```json
  { "signalk": { "requires": ["signalk-container"] } }
  ```
  The types the library ships are a *mirror* of `signalk-container/types`, verified at build
  time — not a dependency.
- **`start()` must never throw.** The SignalK server does **not** await `start()`, so an async
  failure inside it becomes an unhandled rejection. Wrap async startup in `startSafely(app, fn)`.
- Install: `npm install signalk-container-helper` (add `react` too, as a devDependency, only if
  you use the `/ui` panel components).

## 1. Pick the archetype

Two shapes, two classes. Choose by *who owns the container's lifecycle*.

- **`ManagedContainer`** — your plugin owns the container (the `signalk-backup` / `mayara`
  archetype). It pulls, creates, starts, updates, and stops it.
- **`AdoptedContainer`** — the container is managed elsewhere (a systemd Quadlet, an external
  host — the `signalk-doctor` / `signalk-updater` archetype). You only register it for update
  notifications and probe its health over HTTP; you **never** touch its lifecycle. Note:
  `manager.getState()` can't see it — signalk-container namespace-prefixes what *it* manages
  (`sk-<name>`), and adopted peers don't carry the prefix (and "running" ≠ "healthy" anyway).

## 2. ManagedContainer — the lifecycle in one object

```ts
import { ManagedContainer, startSafely } from "signalk-container-helper";

let container: ManagedContainer | null = null;
let settings: MyConfig;

function start(rawConfig: unknown) {
  settings = { ...SCHEMA_DEFAULTS, ...rawConfig }; // SK does NOT seed schema defaults

  container = new ManagedContainer({
    app,
    pluginId: "signalk-myservice",
    name: "myservice",                 // unprefixed; the runtime name is sk-myservice
    image: "ghcr.io/example/myservice",
    defaultTag: "latest",
    buildConfig: (tag) => ({           // declarative & idempotent; SK-container recreates on drift
      image: "ghcr.io/example/myservice",
      tag,
      signalkAccessiblePorts: [9000],  // let signalk-container wire networking (bare-metal or containerized)
      signalkDataMount: "/data",       // plugin data dir, deployment-agnostic — no host paths
      env: { LOG_LEVEL: "info" },
      restart: "unless-stopped",
      resources: { cpus: 1, memory: "512m", pidsLimit: 100 },
    }),
    readiness: { port: 9000, path: "/api/health" }, // "running" ≠ "app answers HTTP"
    updates: {
      versionSource: { githubReleases: "example/myservice" },
      currentTag: () => settings.imageTag ?? "latest",
    },
  });

  startSafely(app, async () => {
    const { address } = await container!.start(settings.imageTag);
    // address = "http://127.0.0.1:9000" — the app answered /api/health
    app.setPluginStatus("Running");
  });
}

async function stop() {
  await container?.stop();   // unregister updates + STOP (not remove); never throws
}
```

`container.start(tag)` does, in order: waits for the manager global (plugins load
alphabetically — signalk-container may load after you) then for runtime detection to settle;
validates the tag against `/^[a-zA-Z0-9._-]+$/`; **self-heals** (if the live image differs from
desired, `recreate`s immediately instead of waiting on drift detection); `ensureRunning`;
registers for updates (non-fatal); resolves the address for `readiness.port`; and waits for
HTTP readiness. Progress is reported via `app.setPluginStatus`; the final "Running" line is
yours.

## 3. AdoptedContainer — register + health-probe, never manage

```ts
import { AdoptedContainer, probeHttpHealth, startSafely } from "signalk-container-helper";
const ENGINE_URL = "http://127.0.0.1:3004";

const adopted = new AdoptedContainer({
  app, pluginId: "signalk-mytool",
  containerName: "mytool-server",
  image: "ghcr.io/example/mytool-server",
  currentTag: "latest",                                  // what the deployment pins
  currentVersion: async () => (await (await fetch(`${ENGINE_URL}/api/health`)).json()).version ?? null,
  versionSource: { githubReleases: "example/mytool-server" },
  checkInterval: "24h",
});

startSafely(app, async () => {
  if (!(await adopted.register())) return;               // false + setPluginError when unavailable; never throws
  const probe = await probeHttpHealth(`${ENGINE_URL}/api/health`);
  if (!probe.reachable) app.setPluginError("mytool-server not reachable — is its service running?");
  else if (probe.slowMs) app.setPluginStatus(`Reachable but slow (${probe.slowMs}ms)`); // SK has no warn tier
  else app.setPluginStatus("Running");
});
// stop(): adopted.unregister();
```

## 4. Update routes (the user owns updates)

Update detection *notifies*; *applying* is an explicit action. Mount the routes on the
`IRouter` the server hands you and persist the **requested** tag, not the resolved version, so
floating tags like `auto`/`latest` keep auto-tracking across restarts:

```ts
function registerWithRouter(router) {
  container?.registerUpdateRoutes(router, {
    onApplied: (requestedTag) => {
      settings.imageTag = requestedTag;                  // persist "auto", not the version it resolved to
      app.savePluginOptions(settings, () => undefined);
    },
  });
}
// mounts GET  /plugins/<id>/api/update/check   → UpdateCheckResult
//        POST /plugins/<id>/api/update/apply   { tag? }
```

## 5. Config-panel UI (`signalk-container-helper/ui`)

A separate browser-side subpath ships the React building blocks the reference plugins kept
copy-pasting — `StatusCard`, `VersionSelect`, `UpdateControls`, form scaffolding, and the
`useStatusPoll` / `useVersions` / `useUpdateFlow` hooks — plus a shared inline-style vocabulary
(`panelStyles`). Inline styles are deliberate: a CSS file from a federation remote leaks into or
is clobbered by the host Admin UI page. The core entry stays Node-only and dependency-free;
`/ui` needs `react` (an optional peer, bundle-time only — the Admin UI provides the singleton).

**The federation gotcha that wastes the most time:** SignalK injects your panel's script tag
based on your plugin's `package.json` `type` field. An ESM plugin (`"type": "module"`) is loaded
with dynamic `import()` and needs a real ESM Module-Federation remote (`library: { type:
"module" }`, `experiments.outputModule: true`). A copied CommonJS `var` remote loads silently
with no exports and the panel dies with *"Module … is not available. Make sure the webapp is
installed"* even though discovery and serving worked. Match the remote's output format to your
package's `type`. Verify:
`node -e 'import("./public/remoteEntry.js").then(m => console.log(typeof m.get, typeof m.init))'`
(both must print `function`).

## 6. Conventions the library encodes — adopt them even without the components

- **Offline is a state, not an error.** Boats lose connectivity; show "last checked 3h ago",
  don't fail the plugin or paint the panel red.
- **Stop, don't remove.** `stop()` leaves the container in place so re-enabling the plugin
  restarts it instantly with no pull.
- **A controlled `<select>` must always render its value.** If the running tag isn't in the
  options (a GitHub rate-limit hid it), inject a synthetic `<tag> (running)` option — otherwise
  the browser shows the first option and the next Save silently changes the running image.
- **Version lists degrade, never wipe.** On a failed `/api/versions` fetch, keep the last known
  list with an error line.
- **Poll by self-scheduling, not `setInterval`.** On a slow host one response can outlast the
  poll period; start the next request only after the previous settled, and drop stale responses.
- **Parse status bodies on non-2xx.** A 503 often carries the very fields the operator needs.

## 7. Errors & version compatibility

Everything the helpers throw is a typed `ContainerHelperError` with a `code`
(`manager-unavailable`, `no-runtime`, `invalid-tag`, `address-unresolved`, `not-ready`,
`recreate-limbo`) that has **already** been surfaced via `app.setPluginError` (`reported:
true`), so `startSafely` won't double-report it. Newer signalk-container capabilities are
feature-detected with graceful fallbacks: `recreate` (≥ 1.12.0 — self-heal is skipped below
that), `getLogs` (≥ 1.7.0), `healthcheck` (≥ 1.14.0), `ulimits` (≥ 1.17.0),
`devices`/`groupAdd` (≥ 1.24.0). Runtime floor is signalk-container ≥ 1.6.0; the type contract
is validated against ≥ 1.23.2 (dev-only).

## Testing

The library's own patterns test cleanly without containers: keep pure helpers (tag validation,
version-list view logic, message formatting) separate and unit-test them directly; mock the I/O
boundary (the `app.*` calls, HTTP fetches) or exercise it against a throwaway local `http`
server. `vitest` for TS.
