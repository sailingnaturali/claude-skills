---
name: repo-scaffold
description: Use when creating a repository or upgrading its scaffolding — agent context files, line-ending normalization, format/lint CI, container CVE scanning, tag-triggered publishing, release automation, and generated release notes. Encodes the working set from maintained repos, CLAUDE.md importing AGENTS.md via the @-syntax (a plain link does not load), .gitattributes eol=lf (the Windows-CI "Delete ␍" fix), prettier+eslint as a read-only CI gate, a weekly Trivy scan tuned to actionable findings, tight dotted semver tag globs with prerelease-safe latest, the verified release-please adoption path (token-cascade dispatch, the Actions-may-create-PRs setting, concurrency, issues-write), and label-categorized release notes.
---

# Repo scaffolding that pays rent

Six pieces of scaffolding, each of which has already paid for itself in a maintained repo.
Copy the shapes; the rationale is what keeps them from being cargo cult.

## 1. Agent context: `AGENTS.md`, imported by `CLAUDE.md`

Repo conventions (architecture, invariants, workflow rules) live in **`AGENTS.md`** — the
vendor-neutral file that multiple coding agents read. `CLAUDE.md` then contains exactly one
line:

```text
@AGENTS.md
```

The `@` **import syntax matters**: it inlines the whole file into the agent's context at
session start. A plain markdown link (`See [AGENTS.md](AGENTS.md).`) is *not* followed
automatically — observed side by side in two live repos: the `@`-import version loaded the
full conventions, the link version loaded only the one-line stub. If your conventions aren't
reaching the agent, check which form the repo uses.

## 2. `.gitattributes`: one line ends a whole failure class

```gitattributes
* text=auto eol=lf
```

Prettier and eslint enforce LF. Without this line, Windows CI runners (and contributors with
`core.autocrlf`) check out CRLF and `prettier --check` fails on **every line** with
``Delete `␍` `` — a wall of red unrelated to the change. Related Windows-runner trap: npm
script globs must be double-quoted (`"dist/test/*.test.js"`) or Windows expands them.

## 3. Format locally, verify in CI

Two package.json scripts, one writing, one read-only:

- `format` — `prettier --write . && eslint --fix` (the developer's command)
- `ci-lint` — `eslint && prettier --check .` (what CI runs — read-only, so uncommitted
  format drift fails the build instead of being silently "fixed")

Wire `ci-lint` into the PR workflow of every repo, including ones that started as pure
docs/shell — retrofitting it later means a noisy reformat commit. After bumping prettier /
eslint / typescript versions, run `npm install` before `format`: formatter output diverges
between versions and CI will reject stale-toolchain output.

## 4. Container repos: a weekly Trivy scan, tuned to be actionable

For any repo that publishes a container image, add a scheduled CVE scan (shape from a live
workflow):

- **Weekly cron + `workflow_dispatch`, not per-PR** — freshly disclosed CVEs surface without
  any code change, and per-PR would add an image build (often QEMU) to every PR.
- Build the amd64 image with `push: false, load: true`, scan with the Trivy action, output
  SARIF, upload to the repo's Security → Code scanning tab.
- **Tune for signal**: `ignore-unfixed: true` (CVEs with no fixed version are noise you
  cannot act on) and `severity: HIGH,CRITICAL`. Informational — it gates nothing; a finding
  in a hand-pinned binary is the cue to bump that version ARG.
- Hygiene: guard the job with `if: github.repository == '<owner>/<repo>'` so forks don't
  burn their minutes, and `persist-credentials: false` on checkout when no later step needs
  the token.

## 5. Publishing is tag-triggered CI — never a laptop

- **npm packages: OIDC trusted publishing.** No `NPM_TOKEN` secret, no OTP in CI — the
  registry trusts the workflow identity. The job needs `permissions: contents: read` +
  `id-token: write` (OIDC is dead without the latter). One wrinkle: a *new* package needs
  one manual CLI+OTP publish before a trusted publisher can be configured for it.
- **Container images: GHCR via `GITHUB_TOKEN`** — job permissions `contents: read` +
  `packages: write` — with the details that bite:
  - Make the tag glob **tight and dotted**: `"v[0-9]*.[0-9]*.[0-9]*"`. A bare `v*` fires on
    `vnext` or `vendor-fix`; even `v[0-9]*` fires on `v1-anything` (the glob is unanchored
    after the digit — this bit a real repo whose `v1-keeper-final` tag matched). Belt-and-braces:
    validate the resolved version against a strict semver regex in the job —
    `workflow_dispatch` inputs are free text.
  - **Prereleases never move `:latest`**: any version with a prerelease suffix (`-beta.1`,
    `-rc.2`, `-alpha.1`, …) publishes `:VERSION` only — key the check on "has a prerelease
    part", not on an enumerated list, or the next suffix style slips through.
  - Create the GitHub Release in a separate job with `needs: publish`, so a failed image
    push can't leave a Release pointing at an image that never reached the registry. Derive
    `prerelease:` from the tag name.
- Pin actions by **version tag** (`actions/checkout@v6`), not by commit SHA — tags stay
  readable and Dependabot-updatable. If an org policy mandates SHA pins, that overrides;
  otherwise treat scanner findings demanding SHA pins as a policy choice, not a defect.

### Or automate the whole ritual: release-please (verified end-to-end)

Instead of hand-cutting `chore(release): X.Y.Z` PRs and tags:
`googleapis/release-please-action@v4` (`release-type: node`) on every push to the default
branch maintains a **standing Release PR** from the conventional commits — version bump in
`package.json` *and* the lockfile, generated changelog, compare/PR/commit links. Merging that
PR creates the tag and the GitHub Release, so releases still gate on a human merge. Verified
in production (a real version shipped through the full chain); **four things bit on adoption**:

- **Tags pushed with `GITHUB_TOKEN` never trigger your tag-based publish workflow** (GitHub's
  recursion guard). No PAT needed: make the release-please workflow dispatch the publish
  workflow explicitly — `gh workflow run publish.yml --ref "$TAG" -f tag="${TAG#v}"` —
  because `workflow_dispatch` is the documented exemption to the guard. Needs
  `actions: write`; dispatching *at the tag ref* builds the tagged tree even if the default
  branch has moved on. Keep the publish workflow's own Release job gated on push events so
  release-please's Release stays the only one.
- **The repo setting "Allow GitHub Actions to create and approve pull requests" is off by
  default** — the first run does all its branch work and then fails with exactly that
  message. Flip it under Settings → Actions → General (or
  `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true`).
- **Serialize with a `concurrency` group** (`cancel-in-progress: false`) — every default-branch
  push runs the workflow, and back-to-back merges race over the same Release PR (observed
  immediately: three merges, three simultaneous runs).
- **Permissions**: `contents: write`, `pull-requests: write`, *plus* `issues: write` — it
  creates its `autorelease` labels through the issues API.

Taxonomy shifts to be aware of: notes come from **commit types**, not PR labels (the
`release.yml` categories below go unused for these releases); `docs` commits are hidden by
default; a `feat` of *any* scope drives a minor — steer an off-policy bump with an empty
commit carrying a `Release-As: X.Y.Z` footer. It also commits a generated `CHANGELOG.md` —
still nothing hand-written, but now a tracked file; configure it away if unwanted.

## 6. Release notes are generated, never hand-written

`generate_release_notes: true` on the Release step plus `.github/release.yml` to categorize
the merged PRs by label:

```yaml
changelog:
  exclude:
    labels: [skip-changelog]
  categories:
    - title: 🚀 Features
      labels: [feature, enhancement]
    - title: 🐛 Fixes
      labels: [bug, fix]
    - title: 📦 Dependencies
      labels: [dependencies]
    - title: Other
      labels: ["*"]
```

The notes are built from **PR titles** — which is the operational reason PR titles must
describe the change ("if someone only read the title, would they understand what this
does?"). No hand-maintained CHANGELOG file; it drifts and duplicates the Releases page.

---

*All shapes lifted from live, maintained repos (verified 2026-08-04): the `.gitattributes`
line and its Windows-CI rationale, the format/ci-lint script pair, the weekly Trivy workflow
(cron, SARIF, ignore-unfixed, HIGH/CRITICAL), the dotted tag glob + semver validation +
prerelease-safe `:latest` + `needs:`-gated Release, and the label-categorized `release.yml`.
The `@AGENTS.md` import-vs-link behavior observed live in two repos side by side. The
release-please flow verified end-to-end on a production container repo (2026-08-06): Release
PR → human merge → tag + Release → dispatched publish at the tag ref → multi-arch registry
manifest with `:VERSION` + `:latest`; all four adoption gotchas above were hit and resolved
in that run, not copied from documentation.*
