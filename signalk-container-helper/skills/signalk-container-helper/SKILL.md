---
name: signalk-container-helper
description: Use when building a SignalK server plugin that reaches a service running in a Docker/Podman container through the signalk-container manager — the signalk-container-helper library that packages the container lifecycle (wait for the manager, validate the tag, self-heal, ensureRunning, wait for HTTP readiness, cancel and serialize operations, wire update routes, stop cleanly), the managed-vs-self-hosted endpoint switch, host path and device resolution, and the shared React config-panel building blocks, so you stop hand-writing the same integration glue.
---

# Build a containerized SignalK plugin with signalk-container-helper

Containerized SignalK plugins all hand-write the same glue: poll for the container manager,
validate the image tag, call `ensureRunning`, wait for the app inside the container to answer
HTTP, register for update detection, mount update routes, and stop cleanly.
[`signalk-container-helper`](https://github.com/hoeken/signalk-container-helper) packages those
patterns — extracted from `signalk-backup`, `mayara-server-signalk-plugin`, `signalk-doctor`,
`signalk-questdb`, and `signalk-updater` — into one typed, zero-runtime-dependency API. It sits
on top of the [`signalk-container`](https://github.com/dirkwa/signalk-container) manager plugin,
which does the actual podman/docker work.

> **Verified against `signalk-container-helper` v0.11.0 (August 2026), manager 1.32.x.**
> Version-sensitive claims — the export list, the error codes in §8, the manager floors — churn
> while the library is at 0.x. Check them against the installed copy (`node_modules/signalk-container-helper/package.json`,
> and `src/types.ts` for the floors) rather than debugging a mismatch. Numbers below are cited
> where behaviour depends on them.

## 0. Wiring & constraints (get these right first)

- **ESM only, Node ≥ 22.** The library ships as an ES module (`import`, not `require`); your
  plugin must be ESM too.
- **Runtime-only coupling — never add `signalk-container` to `dependencies`.** Its prerelease
  versioning breaks npm semver ranges. Declare the relationship instead; the library reaches the
  manager through a runtime global:
  ```json
  { "signalk": { "requires": ["signalk-container"] } }
  ```
  The types the library ships are a *mirror* of `signalk-container/types`, verified at build
  time — not a dependency.
- **`start()` must never throw.** The SignalK server does **not** await `start()`, so an async
  failure inside it becomes an unhandled rejection. Wrap async startup in `startSafely(app, fn)`.
- **Three entry points.** `signalk-container-helper` (Node, dependency-free),
  `…/schema` (plain JSON Schema fragments, also dependency-free), `…/ui` (browser React —
  `react` is an optional peer, bundle-time only).
- Install: `npm install signalk-container-helper`.

## 1. Pick the shape — by who owns the lifecycle, and whether a container is involved at all

Three seams, not two. The first question is no longer "which class" but "is there a container".

- **`ManagedContainer`** — your plugin owns the container (`signalk-backup` / `mayara`). It
  pulls, creates, starts, updates, and stops it.
- **`AdoptedContainer`** — the container is managed elsewhere (a systemd Quadlet, an external
  host — `signalk-doctor` / `signalk-updater`). You only register it for update notifications
  and probe its health over HTTP; you **never** touch its lifecycle. Note `manager.getState()`
  can't see it: signalk-container namespace-prefixes what *it* manages (`sk-<name>`), adopted
  peers don't carry the prefix, and "running" ≠ "healthy" anyway.
- **Managed *or* self-hosted (`resolveEndpoint`)** — the operator chooses between a container
  you manage and a service already running at a URL they supply. This is a config-level switch
  over the same transport, and §4 covers it. "Self-hosted" means the *service* is remote, never
  the container *engine*: signalk-container talks to local unix sockets only and throws on a
  `tcp://` endpoint, so there is no remote-engine mode to model.

## 2. ManagedContainer — the lifecycle in one object

```ts
import { ManagedContainer, resolveMount, startSafely } from "signalk-container-helper";

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
      signalkAccessiblePorts: [9000],  // let signalk-container wire networking
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
HTTP readiness. Progress goes to `app.setPluginStatus`; the final "Running" line is yours.

### Mounting your plugin's data directory — not what the name suggests

**`signalkDataMount` is signalk-container's OWN data dir, never yours.** The manager calls
`app.getDataDirPath()` on its own app object and memoizes one module-level result shared by
every consumer, so it is structurally incapable of varying per plugin — `pluginId` is manifest
bookkeeping and never reaches mount resolution. Treat the field as "a private writable area
inside the Signal K data tree", nothing more. To mount *your* directory, resolve it and pass a
plain volume:

```ts
const mount = await resolveMount(manager, {
  containerPath: "/data",
  hostPath: app.getDataDirPath(),   // yours, resolved for bare-metal or containerized SK
});
// → { source, containerPath, subPath? } — pass as a normal `volumes` entry
```

Use the **returned** `containerPath` in your commands and config, not the one you passed in:
it comes back with `subPath` already joined, so they differ whenever the mount resolved to a
volume covering a parent.

The named-volume rule matters here (manager **1.32.0+**): a volume attached *above* the target
directory is refused at `ensureRunning` rather than mounted wholesale, because podman's
Docker-compat endpoint ignores subpaths and would hand the container the volume's entire
contents. **Below 1.32.0 that case is silently mounted** — a plugin asking for scratch space
could receive the whole tree. `resolveMount` reports `subPath`, so a deliberately parent-backed
volume stays your explicit choice. `resolveMount` needs manager ≥ 1.7.0 and throws
`unsupported-manager` below it.

### Cancellation and serialization (0.4.0+)

`start`, `stop` and `applyUpdate` take `OperationOptions { signal }` and all run through one
per-instance queue, so a stop during a start no longer races. This replaced roughly 85 lines of
hand-rolled mutex, generation counter and AbortController in each consumer — delete yours.

Cancellation is **cooperative, not pre-emptive**: signalk-container's `ensureRunning`,
`recreate` and `stop` take no signal, so a call already in flight runs to completion. What
aborts is everything around it — waiting for the manager global, the drift probe, readiness
polling, and each step boundary. That is where the minutes actually go. A cancelled operation
throws `ContainerHelperError` with code `cancelled`.

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

## 4. The managed / self-hosted switch (0.8–0.10)

Let the operator run your service in a container you manage, *or* point at one they host
themselves. Two halves, both in the library.

**Config form** — `…/schema` emits **plain JSON Schema fragments, deliberately not TypeBox
types**. Consumers are split across two mutually incompatible packages (`typebox` 1.x and
`@sinclair/typebox` 0.34), and this split is **permanent, not a migration**: `@signalk/server-api`
itself depends on the scoped 0.34, so it is in every consumer's tree regardless. Plain fragments
are the one shape both accept.

```ts
import { managedModeSchema } from "signalk-container-helper/schema";
const MODE = managedModeSchema({ productName: "myservice", image: "ghcr.io/example/myservice" });

// Splice in with Type.Unsafe — identical under both TypeBox packages:
//   managedContainer: Type.Unsafe<boolean>(MODE.managedContainer),
//   externalUrl:      Type.Unsafe<string>(MODE.externalUrl),
```

Spreading a bare fragment into `Type.Object({...})` compiles under typebox 1.x and **fails**
under `@sinclair/typebox` 0.34 ("missing the following properties from type 'TSchema'"), so the
`Type.Unsafe` wrapper is not optional. It emits the same keys in a different *order*; compare
sorted keys if you assert on emitted schema.

**Runtime** — `resolveEndpoint` collapses both modes to one base URL:

```ts
import { resolveEndpoint, waitForEndpointReady } from "signalk-container-helper";

const ep = await resolveEndpoint({
  managed: settings.managedContainer,   // undefined MUST mean managed — see below
  externalUrl: settings.externalUrl,
  container,                            // or containerName, if you drive ensureRunning yourself
});
await waitForEndpointReady(ep, { path: "/api/health" });
```

Two traps worth stating plainly:

- **`managed: undefined` means managed.** SignalK calls `start()` with `{}` when a plugin is
  enabled but its form was never saved. Treating that as self-hosted breaks every such install.
- **`mode === "managed"` does not imply `ep.container`.** It is null in self-hosted mode *and*
  in managed mode when you passed `containerName`. Branch on `mode`; null-check `container`
  separately.

Since 0.10.0 the schema hides the external-URL field while managed mode is on, so the form
doesn't ask for an address the plugin will ignore.

## 5. Update routes (the user owns updates)

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

## 6. Config-panel UI (`signalk-container-helper/ui`)

A browser-side subpath ships the React building blocks the reference plugins kept copy-pasting —
`StatusCard`, `VersionSelect`, `UpdateControls`, form scaffolding, the `useStatusPoll` /
`useVersions` / `useUpdateFlow` hooks — plus a shared inline-style vocabulary (`panelStyles`).
Inline styles are deliberate: a CSS file from a federation remote leaks into or is clobbered by
the host Admin UI page.

**The federation gotcha that wastes the most time:** SignalK injects your panel's script tag
based on your plugin's `package.json` `type` field. An ESM plugin (`"type": "module"`) is loaded
with dynamic `import()` and needs a real ESM Module-Federation remote (`library: { type:
"module" }`, `experiments.outputModule: true`). A copied CommonJS `var` remote loads silently
with no exports and the panel dies with *"Module … is not available. Make sure the webapp is
installed"* even though discovery and serving worked. Match the remote's output format to your
package's `type`. Verify:
`node -e 'import("./public/remoteEntry.js").then(m => console.log(typeof m.get, typeof m.init))'`
(both must print `function`).

## 7. Conventions the library encodes — adopt them even without the components

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

## 8. Errors & version compatibility

Everything the helpers throw is a typed `ContainerHelperError` with a `code` that has
**already** been surfaced via `app.setPluginError` (`reported: true`), so `startSafely` won't
double-report it:

`manager-unavailable`, `no-runtime`, `invalid-tag`, `address-unresolved`, `not-ready`,
`recreate-limbo`, `cancelled`, `invalid-option`, `unsupported-manager`, `path-unreachable`,
`external-url-missing`, `external-url-invalid`.

Newer signalk-container capabilities are feature-detected with graceful fallbacks, so a plugin
keeps working against an older manager and only loses the feature. Floors that change
*behaviour* rather than availability: `recreate` (≥ 1.12.0 — self-heal is skipped below),
`resolveHostPath` for `resolveMount` (≥ 1.7.0 — throws `unsupported-manager` below), and the
named-volume scope rule (≥ 1.32.0 — refuses above the target directory; **silently over-mounts
below**). Runtime floor is signalk-container ≥ 1.6.0; the type contract is validated against a
newer one at build time (dev-only, see the library README for the current number).

Other exports worth knowing before you write your own: `retryForever` / `anySignal` (bounded
retry with composed abort signals), `probeHostDevice` (does `/dev/...` exist and is it usable),
`normalizeExternalUrl` (operator input → scheme-ful, trailing-slash-free base), and
`fetchWithTimeout` / `waitForHttpReady` / `probeHttpHealth`. On `ManagedContainer` itself,
`getStateDetail()` surfaces richer manager state (degrades on signalk-container < 1.31.0).

## Testing

The library's own patterns test cleanly without containers: keep pure helpers (tag validation,
version-list view logic, message formatting) separate and unit-test them directly; mock the I/O
boundary (the `app.*` calls, HTTP fetches) or exercise it against a throwaway local `http`
server. `vitest` for TS.
