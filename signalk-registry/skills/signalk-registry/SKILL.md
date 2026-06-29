---
name: signalk-registry
description: Use when publishing or maintaining a SignalK plugin and you want to know its registry score. Fetches the actual published score from the registry, then previews the criteria you can fix locally (screenshots, changelog, audit, plugin-CI) and shows what each gap costs.
---

# SignalK Registry Score

The [SignalK plugin registry](https://signalk.org/signalk-plugin-registry/) scores every plugin
on a 100-point scale and re-tests nightly. This skill does two things:

1. **Reads the actual published score** for the plugin (the ground truth — don't guess it).
2. **Previews the criteria you can act on locally** before the next nightly run, and shows the
   point cost of each gap.

**Our bar: we publish/maintain to 100.** Anything below means a gap below is open.

## Scoring rubric

The 0–100 score is `test-harness/score.ts` (base, max 100) **minus** a plugin-CI penalty applied
in `build-api.ts`. So without plugin-CI the ceiling is **90**, not 100.

| Category | Points | Evaluated |
|----------|--------|-----------|
| Installs | 20 | Registry harness only |
| Loads | 15 | Registry harness only |
| Activates | 15 | Registry harness only |
| Schema | 5 | Registry harness only |
| Tests pass | 25 | Registry harness only |
| Security audit | 0–20 | **Locally checkable** |
| Changelog | −5 if missing | **Locally checkable** |
| Screenshots | −5 if missing | **Locally checkable** |
| **Plugin-CI** | **−10 if missing** | **Locally checkable** (workflow file) |

Install / load / activate / schema / tests (80 pts) run in the registry's own harness against a
live SignalK server — you can't reproduce them locally, but the published JSON (Check 0) reports
their booleans. The rest you can fix in the repo before the next nightly.

## Check 0 — actual published score (do this first)

The registry serves each plugin's results as JSON. The slug is the npm name with `@` stripped and
`/` → `__`.

```bash
PKG=$(node -p "require('./package.json').name")            # @sailingnaturali/signalk-currents
SLUG=$(printf '%s' "$PKG" | sed 's/^@//; s#/#__#')         # sailingnaturali__signalk-currents
curl -s "https://signalk.org/signalk-plugin-registry/plugins/$SLUG.json" -o /tmp/sk-reg.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/sk-reg.json'))
vers = d.get('versions', {})
latest = max(vers, key=lambda v: [int(x) for x in v.split('.') if x.isdigit()]) if vers else None
slot = (vers.get(latest, {}) or {}).get('server@stable', {}) if latest else {}
print(f"latest tested version: {latest}")
print(f"  composite: {slot.get('composite')}")
print(f"  badges: {slot.get('badges')}")
print(f"  installs/loads/activates: {slot.get('installs')}/{slot.get('loads')}/{slot.get('activates')}")
print(f"  tests: {slot.get('test_status')}  audit C/H/M: {slot.get('audit_critical')}/{slot.get('audit_high')}/{slot.get('audit_moderate')}")
print(f"  plugin_ci: {d.get('plugin_ci', {}).get('status')}")
PY
```

Notes:
- The published version may lag your latest npm release until the next nightly re-test — a fresh
  release won't show until the harness runs.
- `no-plugin-ci` in the badges (or `plugin_ci.status: no-plugin-ci`) is the −10 — see the
  plugin-CI check below.
- If a harness boolean is `false` (installs/loads/activates) or `test_status` isn't `passing`,
  that's a real failure in a live server — fix the plugin, not the metadata.

## Check 1 — Screenshots (−5 if missing)

Read `package.json`. Verify all three:

1. `signalk.screenshots` exists as a non-empty array.
2. Each path resolves to a real file on disk (`ls <path>`).
3. Each path is covered by the `files` field (exact match or inside a listed directory).

**Fix:**
```json
"signalk": { "screenshots": ["./docs/screenshots/config.png"] },
"files": ["index.js", "docs/screenshots/"]
```
Then create the image and commit it.

## Check 2 — Changelog (−5 if missing)

Pass if `CHANGELOG.md` exists at repo root, **or** `gh release list` shows a release tagged
`v<version>` for the current `package.json` version.

```bash
ls CHANGELOG.md 2>/dev/null && echo "CHANGELOG.md found"
gh release list --limit 10
```

**Fix:** add a `CHANGELOG.md`, or cut the GitHub Release for the current version.

## Check 3 — Security audit (runtime deps only)

The registry scores the *installed* plugin, so audit production deps only — a dev-only advisory
(esbuild/vitest) doesn't ship and must not skew the result. A zero-dep plugin needs a lockfile or
`npm audit` errors with `ENOLOCK`.

```bash
[ -f package-lock.json ] || npm i --package-lock-only >/dev/null 2>&1
npm audit --omit=dev 2>/dev/null || true
```

| Result | Security points | Penalty |
|--------|----------------|---------|
| No vulnerabilities | 20 | −0 |
| Moderate only | 15 | −5 |
| Any high | 10 | −10 |
| Any critical | 0 | −20 |

**Fix:** `npm audit fix`; for transitive deps, bump the direct dep that pulls them.

## Check 4 — Plugin-CI workflow (−10 if missing; pin must be a current release)

The registry gives a flat **−10** (and a `no-plugin-ci` badge) unless the repo runs SignalK's
**reusable** plugin-CI workflow, which cross-tests the plugin on Linux x64/arm64, macOS, Windows,
and armv7/Venus-OS (Cerbo). Add `.github/workflows/plugin-ci.yml`:

```yaml
name: SignalK Plugin CI
on:
  push: { branches: ['**'] }
  pull_request: { branches: ['**'] }
jobs:
  plugin-ci:
    uses: SignalK/signalk-server/.github/workflows/plugin-ci.yml@<release-sha> # vX.Y.Z
```

**Pin to a release commit SHA, never `@master`** (supply-chain safety + reproducibility), with the
version in a trailing comment. Prereqs for green CI: a committed `package-lock.json` (the workflow
runs `npm ci`) and a passing `npm test`.

Verify the pin is present and current:

```bash
# our pinned ref + version comment
grep -nE 'plugin-ci\.yml@' .github/workflows/plugin-ci.yml 2>/dev/null || echo "NO plugin-ci.yml (-10)"
ref=$(grep -oE 'plugin-ci\.yml@[0-9a-fA-F]+' .github/workflows/plugin-ci.yml 2>/dev/null | cut -d@ -f2)
case "$ref" in
  master|main|"") echo "pin is a branch/missing — pin a release SHA instead" ;;
esac
# latest signalk-server release, dereferenced to a commit SHA
tag=$(gh release view --repo SignalK/signalk-server --json tagName --jq .tagName)
obj=$(gh api "repos/SignalK/signalk-server/git/refs/tags/$tag" --jq '.object')
sha=$(printf '%s' "$obj" | python3 -c "import sys,json;o=json.load(sys.stdin);print(o['sha'])")
[ "$(printf '%s' "$obj" | python3 -c "import sys,json;print(json.load(sys.stdin)['type'])")" = tag ] && \
  sha=$(gh api "repos/SignalK/signalk-server/git/tags/$sha" --jq '.object.sha')
echo "latest signalk-server release: $tag ($sha)"
echo "our pin: $ref"
[ "$ref" = "$sha" ] && echo "pin is current" || echo "pin is BEHIND — update to $tag ($sha)"
```

**Fix when behind:** bump the `@<sha> # vX.Y.Z` to the latest release's SHA and comment. Only move
to a tag that actually contains `.github/workflows/plugin-ci.yml` (it must resolve at that ref).

## Check 5 — Version already on npm (warning, not scored)

```bash
PKG=$(node -p "require('./package.json').name"); VER=$(node -p "require('./package.json').version")
npm view "$PKG@$VER" version 2>/dev/null
```
If it prints, that version is already published — `publish.yml` will fail on the release. Bump
`package.json` before cutting a release.

## Check 6 — Repo metadata (presentation, not scored)

The registry doesn't score these, but every `@sailingnaturali` plugin repo carries them so the
plugin is discoverable on GitHub and links back to its npm package. They live on the GitHub repo
(not `package.json`), so the registry/score checks above never catch a gap — verify explicitly.

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)   # or pass owner/name
PKG=$(node -p "require('./package.json').name")
gh api "repos/$REPO" --jq '{description:(.description//"❌ MISSING"), homepage:(.homepage//"❌ MISSING"), topics:.topics}'
```

Pass criteria (mirror `signalk-equipment-registry`):
- **description** — non-empty, a one-line "what it does".
- **homepage** — the npm package URL: `https://www.npmjs.com/package/<PKG>`.
- **topics** — include at least `signalk`, `signalk-plugin`, `marine`, plus plugin-specific tags.

**Fix:**
```bash
gh api --method PATCH "repos/$REPO" -f homepage="https://www.npmjs.com/package/$PKG"
# topics need a JSON array (the -f "names[]=..." form 422s):
jq -n '{names:["signalk","signalk-plugin","marine"]}' | gh api --method PUT "repos/$REPO/topics" --input -
```

## Check 7 — Display name (presentation, not scored)

The registry doesn't score this, but without `signalk.displayName` both the registry listing and
the in-server App Store fall back to the raw npm `name` — so a scoped package shows the ugly
`@sailingnaturali/signalk-<name>` instead of a human label (this bit `signalk-journey-replay`).

```bash
node -p "require('./package.json').signalk?.displayName || '❌ MISSING'"
```

Pass: a short, human name ("Currents", "Depth Offsets", "Journey Replay") — not the npm name.

**Fix:** add it to the `signalk` object (same one as `screenshots`); takes effect on the next release.
```json
"signalk": { "displayName": "<Friendly Name>", "screenshots": ["./docs/screenshots/config.png"] }
```

## Check 8 — Companion plugins (presentation, not scored)

The App Store renders `signalk.requires` as a **"Required plugins"** section (with a one-click
*Install required plugins* button) and `signalk.recommends` as the **"Works well with"** click-through
cards. Neither affects the score, and neither is an npm dependency — they're App-Store-only
composition hints. A plugin that names a companion only in its README prose but omits it here gets
no card, so the relationship is invisible in the App Store (this bit `signalk-dsc` — the README
named the Logbook plugin but `recommends` was unset).

```bash
node -p "JSON.stringify(require('./package.json').signalk?.requires || [])"     # mandatory companions
node -p "JSON.stringify(require('./package.json').signalk?.recommends || [])"   # suggested companions
# Cross-check: companion SignalK plugins the README names (declared or not)
grep -ioE '@[a-z0-9-]+/signalk-[a-z0-9-]+|signalk-[a-z0-9-]+' README.md | sort -u
```

Pass criteria:
- Every SignalK plugin the README presents as a companion ("works with", "pairs with", "designed
  to work with", "logs to …") is declared in `requires` (hard dependency — the plugin doesn't
  function without it) or `recommends` (optional pairing). The README ↔ metadata must agree; a
  companion in prose only is a gap.
- Entries are **published npm package names exactly as the App Store lists them** — verify each
  resolves (`npm view <name> version`). The Logbook plugin, e.g., is the scoped
  `@meri-imperiumi/signalk-logbook`, not the unpublished bare `signalk-logbook`. A wrong or
  unpublished name still renders, but as an inert "Not installed" link.

**Fix:** add to the `signalk` object (same one as `displayName`/`screenshots`); takes effect on the
next release.
```json
"signalk": { "recommends": ["@meri-imperiumi/signalk-logbook"] }
```

## Output

Present a card: the **published** score first (ground truth), then the locally-fixable gaps,
then repo presentation (separate — not part of the score).

```
Published: 90/100  (sailingnaturali__signalk-currents, v0.5.1)
  installs/loads/activates ✓✓✓   tests passing   audit clean

Local gaps (apply before the next nightly):
  ✗ plugin-CI      −10   no .github/workflows/plugin-ci.yml — add the reusable workflow (pin a release SHA)
  ✓ screenshots    ok    signalk.screenshots present, files covered
  ✓ changelog      ok    GitHub Release v0.5.1
  ✓ audit          ok    0 vulnerabilities

Projected after fixes: 100/100
  ⚠ v0.5.1 already on npm — bump before cutting a release

Repo presentation (not scored):
  ✓ description    ok
  ✗ homepage       set to https://www.npmjs.com/package/@sailingnaturali/signalk-currents
  ✓ topics         ok    signalk, signalk-plugin, marine, …
  ✓ displayName    ok    "Currents"
  ✓ companions     ok    recommends: @meri-imperiumi/signalk-logbook (README ↔ metadata agree)
```

Projected score = base harness (assume passing unless Check 0 says otherwise) − open penalties.
```

## Maintenance — verify the rubric mirror against upstream

The "Scoring rubric" table above hand-mirrors the registry's scorer, so it can silently drift
when upstream changes the rubric. **Don't clone/run the harness to check** — the registry runs it
under `firejail --net=none`, so a local run diverges (a plugin that hits the network in `start()`
gets a false pass without the sandbox). Just diff the two source files via the API and reconcile
the table:

- `test-harness/score.ts` — the 0–100 base rubric (`computeScore`).
- `scripts/build-api.ts` — applies the `−10` `no-plugin-ci` penalty on top of the base.

```bash
REPO=SignalK/signalk-plugin-registry
# Last reconciled upstream SHAs (bump both when you re-sync the rubric table):
SCORE_PIN=5017169f038f4e915d969fe3b9d4105368293362    # test-harness/score.ts
BUILDAPI_PIN=3a62e1ebef42aeca04824e429ad3c2d434044e99 # scripts/build-api.ts

for spec in "test-harness/score.ts:$SCORE_PIN" "scripts/build-api.ts:$BUILDAPI_PIN"; do
  f=${spec%:*}; pin=${spec#*:}
  up=$(gh api "repos/$REPO/commits?path=$f&per_page=1" --jq '.[0].sha')
  if [ "$up" = "$pin" ]; then echo "✓ $f current ($up)"
  else echo "✗ $f CHANGED — read diff: gh api repos/$REPO/compare/$pin...$up --jq '.files[].patch'"; fi
done
```

If either changed: read the diff, update the rubric table / penalties above, then bump the pin.

**Note (decided 2026-06-29, not adopted):** `test-harness/detect-sandboxed.ts` is the only harness
piece that scores a *working tree* (load/activate/schema) rather than a published `name@version`.
We chose **not** to wire it in — it needs the registry's `ts-node`/`esm-resolve` toolchain and runs
*without* firejail locally (the false-pass issue above), so it can't be invoked in a way that
matches the nightly. Revisit only if upstream ships it as a standalone, sandbox-aware CLI.
