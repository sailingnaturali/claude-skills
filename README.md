# Sailing Naturali — Claude Code skills

A small [Claude Code](https://claude.com/claude-code) plugin marketplace of skills we've
found generally useful while building the [Sailing Naturali](https://github.com/sailingnaturali)
marine-AI stack.

## Install

```
/plugin marketplace add sailingnaturali/claude-skills
/plugin install signalk-plugin@sailingnaturali     # or signalk-container-helper@…, signalk-e2e@…, coderabbit-cli@…, signalk-registry@…, npm-oidc-publish@…, oss-branch-protection@…, debug-mcp-agent@…, record-web-gif@…
```

## Plugins

### `signalk-plugin`
Authoring and publishing a [SignalK](https://signalk.org) server plugin to npm — the
`@signalk/server-api` patterns that actually work (serve data via a resource provider, not an
admin-gated router; deltas; vessel position), the **ESM** scaffold (supported since server
2.14; default-export the plugin factory), defining the config schema once in **TypeBox**
(`@signalk/server-api` ships it — one definition is both the admin-UI form and the TS type),
webapp view state in a **Zustand** store so it survives navigation, the
**no-install-scripts rule** (app-store installs pass `--ignore-scripts`, npm 12 gates
dependency scripts, and a plugin can't whitelist itself — containerize heavy parts via the
signalk-container manager instead), **where to store what** (server-owned config vs
`getDataDirPath()` vs the applicationData API — and never inside `node_modules`, where
updates erase it), npm **OIDC trusted publishing** (including the new-package first-publish
chicken-and-egg), and the Docker `node_modules` / `EBUSY` install gotcha.

### `signalk-container-helper`
Building a SignalK plugin that runs a Docker/Podman container through the
[signalk-container](https://github.com/dirkwa/signalk-container) manager, using the
[`signalk-container-helper`](https://github.com/hoeken/signalk-container-helper) library. Packages the
container lifecycle (wait for the manager, validate the tag, self-heal a drifted image, `ensureRunning`,
wait for HTTP readiness, wire update routes, stop cleanly), the `ManagedContainer` vs `AdoptedContainer`
split, and the shared React config-panel components — with the gotchas that cost the most time (the ESM
Module-Federation remote, never throwing out of `start()`, "offline is a state not an error").

### `signalk-registry`
Check a SignalK plugin's expected [registry](https://signalk.org/signalk-plugin-registry/) score
before publishing — evaluates screenshots, changelog, audit, and version-collision risk (the
locally-checkable criteria) and outputs a score card with what each gap costs. After shipping a
fix, **trigger an on-demand re-score** with the registry's `[rescore]` issue template (bot
scans, comments the new score, closes the issue in minutes — `/rescore <npm-name>` re-runs it)
instead of waiting for the nightly.

### `npm-oidc-publish`
Publishing **any** npm package from GitHub Actions via **OIDC trusted publishing** — no
`NPM_TOKEN`, no OTP in CI. The release-triggered workflow, the new-package first-publish
chicken-and-egg (CLI+OTP once, then configure the trusted publisher), and the
registry-propagation 404 gotcha.

### `oss-branch-protection`
Applying one **branch-protection template** across every public repo in a GitHub org — one
idempotent script. **Admin-exempt** so a solo maintainer keeps direct-commit / force-push,
while contributors get CI-gated merges, blocked force-push/deletion, and required conversation
resolution. Derives each repo's required CI check from real check-runs (preferring a stable
aggregate gate) so a wrong context name can't silently wedge PRs.

### `debug-mcp-agent`
Debugging an MCP / tool-backed AI agent by **probing ground truth before trusting its
self-report**: 404-vs-error, which-model-is-driving, server-down vs missing-data,
auth-vs-absence.

### `record-web-gif`
Recording a running web app — a local dev server or a live URL — to a clean GIF for a README,
PR, or demo. Drives **system Chrome via `puppeteer-core`** (no chromium download), captures
frames over CDP, and assembles with **ffmpeg** (2-pass palette). Handles the headless
**WebGL/canvas blank-frame** gotcha (MapLibre, three.js, charts) and the headful-for-smoothness
tradeoff.

### `signalk-e2e`
Browser-level end-to-end testing **before opening the PR** — two co-installed skills that share
one core rule: gate the change on a green Playwright run and attach it as PR evidence.
- **`webapp-e2e`** — the general case. Any web app change: a dev server, a live URL, or an
  isolated component like a plugin config panel. Playwright with the repo's bundled chromium (not
  a system/MCP browser), role/label locators + auto-waiting assertions, mounting a
  Module-Federation remote for test, and the headless blank-canvas gotcha. (Distinct from
  `record-web-gif`, which *records* a demo rather than *verifies*.)
- **`signalk-server-e2e`** — the SignalK-specific harness layered on top: spin up a local server
  on a scratch config, feed live data over the WebSocket delta stream, and the verified
  Freeboard-SK chart recipe. Defers the shared browser mechanics to `webapp-e2e`.

### `coderabbit-cli`
Driving the **[CodeRabbit](https://coderabbit.ai) CLI** (`cr`) as the review gate before opening
a PR — the **three mechanics that decide whether a rate-limited run counts**, which the official
docs don't carry: **commit first** and scope with `--committed` (a dirty-tree review judges the
wrong diff and can "pass" without seeing your work), **pin the base** with
`--base-commit $(git merge-base origin/main HEAD)` (`--base` resolves against the *local*
branch — a stale local main floods you with false positives), and **save the output before it's
lost** (`tee` to a slash-sanitized path outside the tree; stderr kept out of `--agent`'s
structured stream; `cr review findings` re-reads the last run for free). Plus the `--plain`
removal trap, verified: 0.7.x errors on it while older docs still show it. Requires a CodeRabbit
account; the diff is **uploaded to CodeRabbit's cloud**. The full flag reference is deliberately
deferred to CodeRabbit's own CLI docs.

## Skill format policy

Skills in this marketplace follow the cross-vendor
[Agent Skills](https://code.claude.com/docs/en/skills) `SKILL.md` standard: frontmatter is
**`name` and `description` only** — no vendor-specific fields in skill bodies, no
runtime-specific tool ids in prose (write "dispatch a subagent", not a tool name). The
`.claude-plugin/` marketplace/plugin wrappers are Claude Code packaging, not the source of
truth; the same `SKILL.md` files load in Codex, Copilot CLI, and Gemini CLI unchanged.

## License

MIT
