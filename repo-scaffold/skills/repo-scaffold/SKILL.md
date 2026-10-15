---
name: repo-scaffold
description: Use when creating a repository or upgrading its scaffolding — agent context files, line-ending normalization, format/lint CI, container CVE scanning, tag-triggered publishing, release automation, and generated release notes. Encodes the working set from maintained repos, CLAUDE.md importing AGENTS.md via the @-syntax (a plain link does not load), .gitattributes eol=lf (the Windows-CI "Delete ␍" fix), prettier+eslint as a read-only CI gate, a weekly Trivy scan tuned to actionable findings, tag globs as a coarse filter backed by a mandatory in-job semver check, prerelease-safe latest, the verified release-please adoption path (token-cascade dispatch, the Actions-may-create-PRs setting, concurrency, issues-write), and label-categorized release notes.
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
  - **The tag glob is a coarse filter, not validation.** Narrow it —
    `"v[0-9]*.[0-9]*.[0-9]*"` beats a bare `v*`, which fires on `vnext` or `vendor-fix` — but
    do not mistake it for a semver check. GitHub's filter syntax is glob, not regex: `[0-9]`
    matches one digit and the following `*` matches *anything*, so each component is "a digit
    then whatever". `v1x.2y.3z`, `v1abc.2def.3ghi` and `v1.2.3.4` all match this "tight"
    pattern. It only buys you the leading-digit-per-component shape; `v1-keeper-final` is
    excluded, `v1zzz.0zzz.0zzz` is not.
  - **So validate in the job — this step is mandatory, not belt-and-braces.** The glob cannot
    anchor and `workflow_dispatch` inputs are free text, so the only real gate is an explicit
    check that fails the job before anything is published:

    ```yaml
    - name: Validate version is strict semver
      run: |
        VERSION="${GITHUB_REF_NAME#v}"
        # MAJOR.MINOR.PATCH with optional -prerelease and +build (semver.org BNF)
        if ! printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'; then
          echo "::error::Tag '$GITHUB_REF_NAME' is not strict semver - refusing to publish."
          exit 1
        fi
        echo "version=$VERSION" >> "$GITHUB_OUTPUT"
    ```

    Note the `(0|[1-9][0-9]*)` components: they reject leading zeros (`v01.2.3`) as semver
    requires, which a naive `[0-9]+` would let through.
  - **Prereleases never move `:latest`**: any version with a prerelease suffix (`-beta.1`,
    `-rc.2`, `-alpha.1`, …) publishes `:VERSION` only — key the check on "has a prerelease
    part", not on an enumerated list, or the next suffix style slips through.
  - Create the GitHub Release in a separate job with `needs: publish`, so a failed image
    push can't leave a Release pointing at an image that never reached the registry. Derive
    `prerelease:` from the tag name.
- **Action pinning is a real tradeoff — pick one and apply it repo-wide.** A version tag
  (`actions/checkout@v6`) is *mutable*: the tag can be repointed at a new commit, so it is a
  trust decision about the publisher, not a cryptographic guarantee. Only a full commit SHA
  (`actions/checkout@<40-char-sha> # v6`) is immutable, and Dependabot updates SHA pins in
  place when that trailing version comment is kept.
  This scaffold defaults to **version tags** for first-party (`actions/*`, `docker/*`) and
  established third-party actions: readable diffs, no churn, and the same style across every
  workflow in the repo. The cost is accepting the publisher's tag hygiene.
  Choose **SHA pins** when the workflow's blast radius justifies it — anything holding
  `id-token: write` (OIDC publish), `packages: write` (registry push), or `actions: write`,
  and any less-established action — or when org policy mandates it. Both publish workflows
  above are in that category, so this is a live choice, not a formality.
  Whichever you pick, be consistent: a lone SHA-pinned step among tagged ones is noise, and
  mixed styles make scanner findings unreadable. Treat a scanner's blanket "pin to SHA"
  finding as this policy question, not a defect.

**Lint the workflows themselves.** A workflow expression is not checked by anything until the
job runs, and a publish job runs on a tag — so a typo ships and waits. `actionlint` catches it
in seconds:

```bash
actionlint .github/workflows/*.yml
```

The failure worth knowing: **GitHub Actions expressions have no `split()`.** The string and
object functions are `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`,
`fromJSON` and `hashFiles` — plus the status checks `success`, `failure`, `always` and
`cancelled` — and that is all of them, so
`contains(split(github.ref_name, '+')[0], '-')` — a plausible-looking way to read the part of a
tag before its build metadata — is a syntax error that fails the step. It reads fine, and it is
the kind of thing you verify in bash, where `split` does exist. Do the string work in a `run:`
step and pass an output back, or keep the expression to the functions above.

### Or automate the whole ritual: release-please (verified end-to-end)

Instead of hand-cutting `chore(release): X.Y.Z` PRs and tags:
`googleapis/release-please-action@v5` on every push to the default branch maintains a
**standing Release PR** from the conventional commits — version bump in
`package.json` *and* the lockfile, release notes, compare/PR/commit links. Merging that
PR creates the tag and the GitHub Release, so releases still gate on a human merge. (By
default it also commits a generated `CHANGELOG.md`; the configuration below turns that off
and leaves the Releases page as the changelog.) Verified
in production (a real version shipped through the full chain); **three things bit on adoption**,
plus a fourth that bites conditionally:

- **Tags pushed with `GITHUB_TOKEN` never trigger your tag-based publish workflow** (GitHub's
  recursion guard). No PAT needed: make the release-please workflow dispatch the publish
  workflow explicitly — `gh workflow run publish.yml --ref "$TAG" -f tag="${TAG#v}"` —
  because `workflow_dispatch` is the documented exemption to the guard. Needs
  `actions: write`; dispatching *at the tag ref* builds the tagged tree even if the default
  branch has moved on. Keep the publish workflow's own Release job gated on push events so
  release-please's Release stays the only one.

  Three things bite in the dispatched workflow itself:
  - **A plain `needs:` on that Release job skips the publish.** On a dispatch the Release
    job is skipped, and a skipped job skips every job that needs it, so the publish silently
    never runs. Give the publish job a condition that checks the status itself:
    `if: ${{ !cancelled() && needs.release.result != 'failure' }}`.
  - **Check the tag against `package.json` first, in a job both others need.** npm publishes
    `package.json`'s version whatever the tag is called, and neither a `v*` filter nor a
    dispatch checks the name. Inside the publish job the check comes too late: a mismatched
    hand-pushed tag has already got its Release.
  - **npm trusted publishing is bound to the workflow file.** Keep publishing in the file the
    trusted publisher names; moving it into the release-please workflow, or behind a reusable
    workflow, gets the publish refused. That binding is why this is a dispatch at all.

  **Pass the action no inputs.** Give the step `uses:` and an `id:` and nothing else: setting
`release-type:` on the action puts it in single-package mode, where it stops reading
`release-please-config.json` and silently ignores everything configured there —
`changelog-type`, `skip-changelog`, `pull-request-title-pattern`. Put `"release-type": "node"`
in the config file instead, which is where the rest of the settings already are.

**Pass `-f` only for inputs the target workflow declares.** A workflow whose
  `workflow_dispatch:` takes no inputs rejects the dispatch outright —
  `HTTP 422: Unexpected inputs provided: ["tag"]`, nothing queued — so the command above is
  not copy-paste safe across workflows. Check what each one accepts and drop the `-f` where
  there is none. Many workflows need no input anyway: one that derives its version from the
  commit (`git tag --points-at HEAD`) rather than from `GITHUB_REF_NAME` gets everything it
  needs from `--ref "$TAG"`.

  **Dispatch every tag-triggered workflow, not just "the publish one."** The recursion guard
  silences all of them, and a repo often has more than one — a docs/site deploy, a channel
  branch that a dev-environment command clones, a mirror job. The symptom is silence in a
  place nobody watches: the Release appears and looks correct while a downstream consumer
  quietly keeps serving the previous version.

  Inventory them before adopting, and read the triggers rather than grepping for `tags:`: a
  `push:` with no `branches:`/`tags:` filter at all fires on tag pushes too, and workflow
  files may be `.yaml` as well as `.yml`. Then check each one you intend to dispatch actually
  can be — `gh workflow run` needs the workflow to declare `workflow_dispatch` and to exist on
  the default branch. One that is tag-triggered but has neither gets no recovery from this
  approach; give it a `workflow_dispatch` trigger (the cheap fix) or drive it another way.
- **The repo setting "Allow GitHub Actions to create and approve pull requests" is off by
  default** — the first run does all its branch work and then fails with exactly that
  message. Flip it under Settings → Actions → General (or
  `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true`).
- **Serialize with a `concurrency` group** (`cancel-in-progress: false`) — every default-branch
  push runs the workflow, and back-to-back merges race over the same Release PR (observed
  immediately: three merges, three simultaneous runs). Once the gate below is in, put the
  group on the **release-please job**, not the workflow. GitHub keeps one pending run per
  group and replaces it with the newest, so at workflow level a docs push that lands while a
  run is in progress replaces the queued run of the release PR's merge, the gate then stops
  the docs run, and no tag is created until the next releasable push. A run the gate stopped
  should get a group of its own:
  `group: ${{ needs.gate.outputs.releasable == 'true' && 'release-please' || format('release-please-{0}', github.run_id) }}`.
- **Permissions**: `contents: write` and `pull-requests: write` on the release-please job.
  Add `issues: write` if a run fails creating its `autorelease:*` labels — it reaches for the
  issues API to make them, so the need shows up on a repo where they don't exist yet rather
  than on every repo.

Taxonomy shifts to be aware of: by default notes come from **commit types**, not PR labels;
`docs` commits are hidden; a `feat` of *any* scope drives a minor, and a `!`/`BREAKING CHANGE`
a major. **Leave that default alone** — deriving the bump from the commit types is the point
of conventional commits, and it is what makes the version mean something to a consumer. Steer
a one-off off-policy bump with an empty commit carrying a `Release-As: X.Y.Z` footer rather
than by changing the policy.

#### Credit contributors in the notes, and drop `CHANGELOG.md` entirely

Two config lines change the output more than anything above:

`release-please-config.json`, at the repo root:

```json
{
  "release-type": "node",
  "changelog-type": "github",
  "skip-changelog": true,
  "always-update": true,
  "pull-request-title-pattern": "chore: release ${version}",
  "packages": { ".": {} }
}
```

`"packages"` puts this in **manifest mode**, so commit
`.release-please-manifest.json` beside it holding the current version — `{ ".": "0.1.0" }` —
or the first run dies with `Failed to find .release-please-manifest.json`.

`release-type: node` is right only when `package.json` is the thing being versioned, because
it bumps that file and the lockfile. A repo whose `package.json` exists for build tooling —
a docs site renderer, a test harness — usually declares it `private` with **no `version`
field** at all, and there is nothing there to bump. That is the common shape for a pure bash
or PowerShell repo that happens to carry a Node toolchain. Picking `node` by reflex because a
`package.json` is present versions the wrong artifact.

`release-type: simple` is the alternative: it leaves `package.json` alone and tracks the
version in a `version.txt` instead. Commit that file with the current version before the first
run — the strategy updates it with `createIfMissing: false`, so it expects the file to be
there already, the same way manifest mode expects `.release-please-manifest.json`. (Read from
the strategy source, not run here; a repo whose only release artifact is a git tag may prefer
to skip both and hand-cut tags, since `simple` still wants a file to bump.)

No `versioning` key: the default derives the bump from the commit types, which is the
behaviour you want (betas are the exception, below). `always-bump-patch` exists for a repo
whose convention is that every release is a PATCH — a plugin pinned to a host's version
line, say — and it is a deliberate opt-out of semver, not a default worth copying. Set it
only where that convention already holds, and say so in the repo.

- **`changelog-type: github`** hands note generation to GitHub's own API, which is what
  produces the **`by @author`** credit lines. Beware `include-commit-authors`: it looks like
  the option for this and is a **no-op** — `parseConventionalCommits` rebuilds each commit
  without the `author` field, so the notes never see it
  ([release-please#2892](https://github.com/googleapis/release-please/issues/2892), open as of
  September 2026).
- **It also re-activates `.github/release.yml`** (section 6): with GitHub generating the notes,
  your label categories apply again. Exclude release-please's own PR or the notes list
  themselves — `autorelease: pending` and `autorelease: tagged` alongside `skip-changelog`.
  Because the categories are label-driven, pair this with a small workflow that labels each PR
  from its conventional-commit title, or CLI-opened PRs arrive unlabelled and land in "Other".
- **`skip-changelog: true`** keeps no `CHANGELOG.md` at all — the Releases page is the
  changelog. Worth it beyond taste: the generated file trips Prettier, and CI does not run on
  the release PR, so nothing surfaces the failure.
- **`always-update: true`** rebuilds the release PR from the default branch on every run.
  Without it, release-please leaves an open release PR alone whenever its title and notes
  would come out the same. If the default branch moves underneath in a way the notes don't
  show, such as a version bumped by hand, the PR goes conflicting and stays that way (seen
  October 2026).

#### Betas from the same release PR, but not on 0.x

Default versioning keeps a pre-release suffix when it bumps: from `1.3.3-beta.2`, a `fix`
proposes `1.3.4-beta.2`. To cut betas through release-please, set `"versioning": "prerelease"`
and `"prerelease": true`, with no `prerelease-type`. A stable version then bumps to the next
stable (`1.3.2` plus a `fix` gives `1.3.3`) and a beta to the next beta (`1.3.3-beta.2` plus a
`fix` gives `1.3.3-beta.3`). A `Release-As:` footer switches between the two, and
`prerelease: true` is what marks the betas as GitHub pre-releases.

It also marks **every 0.x release** as one. release-please sets the flag to `prerelease &&
(the version has a suffix || major === 0)`, so a 0.x package never gets a release marked
Latest. Leave both keys out until 1.0. (Read from release-please 17.11.2's versioning
strategies and `manifest.js`, October 2026.)

#### Gate the run, or every docs merge proposes a release

release-please has a "no user-facing commits" skip, but **it never fires under
`changelog-type: github`**: GitHub's generated notes are never empty — they always end in a
*Full Changelog* line — so a lone `docs:` or `ci:` merge still opens a release PR.

Put a `gate` job in front that reads the push payload and only lets release-please run when the
push carries something users get — `feat`/`fix`/`perf`/`revert`, any `type!:`, a
`BREAKING CHANGE:` footer, `build(deps):` (a *runtime* bump; Dependabot scopes dev ones
`deps-dev`), or the release PR's own merge:

```yaml
gate:
  runs-on: ubuntu-24.04
  outputs:
    releasable: ${{ steps.check.outputs.releasable }}
  steps:
    - id: check
      env:
        MESSAGES: ${{ toJSON(github.event.commits.*.message) }}
        RELEASABLE: '^((feat|fix|perf|revert)(\([^)]*\))?!?: |[a-z]+(\([^)]*\))?!: |build\(deps\): |Revert |chore(\([^)]*\))?: release v?[0-9])'
      run: |
        if jq -e --arg re "$RELEASABLE" '(length == 0) or (length >= 2048) or ([.[] | (split("\n")[0] | test($re)) or test("\nBREAKING[- ]CHANGE: ") or test("\nRelease-As: "; "i")] | any)' <<< "$MESSAGES" > /dev/null; then
          echo "releasable=true" >> "$GITHUB_OUTPUT"
        else
          echo "releasable=false" >> "$GITHUB_OUTPUT"
        fi
```

The job only computes the answer — the half that makes it a gate is on release-please itself:

```yaml
release-please:
  needs: gate
  if: ${{ needs.gate.outputs.releasable == 'true' }}
```

This reads the **subject line** of each pushed commit. With squash merges that subject is the
PR title. With true merge commits it works too, on different subjects: the push payload holds
the PR's own commits beside the `Merge pull request #N from …` commit, so their subjects are
what gets judged, and the release PR's own release commit lets its merge through (checked
October 2026 on a merge-commit repo: two release PR merges, each of which passed the gate,
was tagged and was published). On such a repo the conventional type has to be on the
commits, not only on the PR title.

**`build(deps):` only appears if Dependabot is told to write it.** Its default prefix follows
the repo's history and is often `chore(deps)`, which the gate never lets through, so a runtime
security bump merges without a release. Set the prefixes in `dependabot.yml`:

```yaml
- package-ecosystem: npm
  commit-message:
    prefix: build # runtime: build(deps)
    prefix-development: build # dev: build(deps-dev)
    include: scope
- package-ecosystem: github-actions
  commit-message:
    prefix: ci # ci(deps)
    include: scope
```

The PR labeler needs the same split: a `build(deps)` PR is what causes its release, so it must
not get `skip-changelog`. Leave it to the `dependencies` label Dependabot sets, and it lands
under 📦 Dependencies.

**The footer tests are not decoration.** A `BREAKING CHANGE:` or `Release-As:` footer is
usually written on a commit whose *subject* is not releasable — the off-policy bump below is
steered with an empty commit, and a breaking change is often a `refactor!`/`chore!`. Without
them the gate skips exactly the commits those footers exist to act on, and the escape hatch
this skill recommends silently does nothing. `Release-As` is matched case-insensitively
because release-please's own parser is: a gate stricter than the thing it gates rejects a
footer release-please would have honoured.

Match the last alternative to your `pull-request-title-pattern` so the release PR's own merge
is always releasable — that merge is what creates the tag. **Fail open** at both ends: on a full
payload (`length >= 2048`) a push that large may hide a releasable commit, and on an empty
one (`length == 0`) there is nothing to judge — `[...] | any` is `false` for an empty array,
so without that clause a payload carrying no `commits` (a branch creation, a tag push, or a
`schedule`/`workflow_dispatch` trigger if the workflow ever grows one) would silently skip.
Let both through rather than miss a release.

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

This file stays in play under release-please when you set `changelog-type: github` — same
categories, plus the `autorelease:*` excludes — so keep PRs labelled.

**Create the labels before anything applies them.** `skip-changelog` is not a default GitHub
label, and `gh pr edit --add-label` fails the step outright on a label the repo does not
define — `'skip-changelog' not found`, exit 1 — so a workflow that labels from the PR title
goes red on the first `ci:` or `chore:` pull request, which is usually the one adopting this.
Naming a missing label in `release.yml` is harmless by contrast: an exclude that matches
nothing simply excludes nothing.

```bash
gh label create skip-changelog --color ededed --description "Left out of the release notes"
```

---

*All shapes lifted from live, maintained repos (verified 2026-08-04): the `.gitattributes`
line and its Windows-CI rationale, the format/ci-lint script pair, the weekly Trivy workflow
(cron, SARIF, ignore-unfixed, HIGH/CRITICAL), the dotted tag glob + semver validation +
prerelease-safe `:latest` + `needs:`-gated Release, and the label-categorized `release.yml`.
The `@AGENTS.md` import-vs-link behavior observed live in two repos side by side. The
release-please flow verified end-to-end on a production container repo (2026-08-06): Release
PR → human merge → tag + Release → dispatched publish at the tag ref → multi-arch registry
manifest with `:VERSION` + `:latest`; all four adoption gotchas above were hit and resolved
in that run, not copied from documentation. The `changelog-type: github` contributor lines,
`skip-changelog`, and the releasable-commit gate verified on two npm plugin repos
(2026-09-21); the gate's judgement observed correctly skipping a `ci:` merge in production.
`include-commit-authors` re-confirmed a no-op against release-please#2892, still open. The
`Release-As` gate gap, the `skip-changelog` label prerequisite and the `split()` expression
error all surfaced adopting this on a sixth repo (2026-09-23); `split()` confirmed undefined by
actionlint 1.7.12, which is where the function list above comes from. The job-level
concurrency group, the dispatched publish job's `needs:` trap and tag check, the
merge-commit behaviour of the gate, `always-update` and the Dependabot prefixes come from
later adoptions on npm plugin repos (September–October 2026); the merge-commit claim was
checked against two release PR merges' runs, and the beta versioning and the 0.x
pre-release flag were read from release-please 17.11.2's source (2026-10-15).*
