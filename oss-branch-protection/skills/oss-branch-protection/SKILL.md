---
name: oss-branch-protection
description: Use when standardizing branch protection across the public repos in a GitHub org, when adding a new OSS repo that needs the same protection as the rest, or when protection has drifted — applies one uniform template (admin-exempt so the maintainer keeps direct-commit/force-push, CI-gated merges for contributors, no force-push/deletion, conversation resolution) and derives each repo's required CI check automatically.
---

# OSS branch-protection template

One protection policy for every **public, non-fork** repo in an org, applied idempotently
with a single script. The policy binds *contributors*, not the solo maintainer.

## The policy

Applied to each repo's default branch:

| Setting | Value | Why |
|---------|-------|-----|
| `enforce_admins` | **false** | The maintainer (admin) stays exempt — keeps a direct-commit-on-`main` + force-push-after-cleanup workflow. Everything below binds non-admins only. |
| Required status checks | the repo's CI gate, `strict` (branch up to date) | No red-CI merges. |
| Required PR reviews | **none** | A solo maintainer can't self-approve, so requiring reviews would just block them. External contributors have no write access — they must PR anyway, and CI gates the merge. |
| Force-push / delete branch | **blocked** (non-admins) | Protects history. Admins bypass via `enforce_admins: false`. |
| `required_conversation_resolution` | **true** | PR threads resolve before merge. |

**Key idea:** `enforce_admins: false` is what makes a strict policy compatible with a
solo maintainer who commits directly. Contributors get the guardrails; the owner keeps
their flow. If your org has multiple committers and wants review enforcement, set
`required_pull_request_reviews` and `enforce_admins: true` instead.

## Deriving the CI gate

Required-check names vary by CI, so the applier reads the checks reported on the default
branch's latest commit and picks a stable gate:

- **Prefer an aggregate gate** if present (e.g. a `CI Status` summary job) — stable across
  matrix changes, unlike per-OS/per-version legs.
- Otherwise require the remaining real checks (test matrix, scanners, `build`).
- **Drop non-gating / unstable contexts:** anything matrix-templated (`${{ … }}`),
  `dependabot`, `deploy`, `publish`, and site-only jobs (`crosspost`,
  `report-build-status`, `update-uv-graph`). These either don't report on `pull_request`
  or would wedge PRs waiting on a check that never runs.
- **No CI on the latest commit → uniform rules only, no required check.** Add a
  `pull_request`-triggered workflow first, then re-run to attach a gate.

> ⚠️ A required status check whose name never reports will block *every* contributor PR
> (the maintainer bypasses via admin-exempt, so you may not notice). This is why the
> applier derives names from real check-runs rather than hardcoding them.

## Apply

Idempotent — safe to re-run after adding CI or a new repo:

```sh
node apply-branch-protection.mjs --dry   # preview: repo → required checks
node apply-branch-protection.mjs         # apply to every public non-fork repo
```

Edit the `sailingnaturali` org name at the top of the script for your own org. Requires
`gh` authenticated with `repo` scope. The script is next to this SKILL.md.

## Verify one repo

```sh
gh api repos/<org>/<repo>/branches/<branch>/protection \
  -q '{checks: .required_status_checks.contexts, admins: .enforce_admins.enabled, force: .allow_force_pushes.enabled}'
```
