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

## Output

Present a card: the **published** score first (ground truth), then the locally-fixable gaps.

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
```

Projected score = base harness (assume passing unless Check 0 says otherwise) − open penalties.
```
