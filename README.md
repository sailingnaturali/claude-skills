# Sailing Naturali — Claude Code skills

A small [Claude Code](https://claude.com/claude-code) plugin marketplace of skills we've
found generally useful while building the [Sailing Naturali](https://github.com/sailingnaturali)
marine-AI stack.

## Install

```
/plugin marketplace add sailingnaturali/claude-skills
/plugin install signalk-plugin@sailingnaturali     # or signalk-registry@…, npm-oidc-publish@…, oss-branch-protection@…, debug-mcp-agent@…, record-web-gif@…
```

## Plugins

### `signalk-plugin`
Authoring and publishing a [SignalK](https://signalk.org) server plugin to npm — the
`@signalk/server-api` patterns that actually work (serve data via a resource provider, not an
admin-gated router; deltas; vessel position), the package scaffold, npm **OIDC trusted
publishing** (including the new-package first-publish chicken-and-egg), and the Docker
`node_modules` / `EBUSY` install gotcha.

### `signalk-registry`
Check a SignalK plugin's expected [registry](https://signalk.org/signalk-plugin-registry/) score
before publishing — evaluates screenshots, changelog, audit, and version-collision risk (the
locally-checkable criteria) and outputs a score card with what each gap costs.

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

## Skill format policy

Skills in this marketplace follow the cross-vendor
[Agent Skills](https://code.claude.com/docs/en/skills) `SKILL.md` standard: frontmatter is
**`name` and `description` only** — no vendor-specific fields in skill bodies, no
runtime-specific tool ids in prose (write "dispatch a subagent", not a tool name). The
`.claude-plugin/` marketplace/plugin wrappers are Claude Code packaging, not the source of
truth; the same `SKILL.md` files load in Codex, Copilot CLI, and Gemini CLI unchanged.

## License

MIT
