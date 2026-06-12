---
name: signalk-registry
description: Use when publishing a SignalK plugin and you want to know your expected registry score. Checks screenshots, changelog, audit, and version-collision warning (the four locally-evaluable criteria) and shows what each gap costs.
---

# SignalK Registry Score Preview

The [SignalK plugin registry](https://signalk.org/signalk-plugin-registry/) scores every plugin
nightly on a 100-point scale. This skill evaluates the criteria you can check right now, before
publishing, and tells you your expected score.

## Scoring rubric

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

Install / load / activate / schema / tests (80 pts) run in the registry's own harness — they
require installing the package into a live SignalK server. Check live results at
https://signalk.org/signalk-plugin-registry/.

The three you can evaluate right now:

## Check 1 — Screenshots (−5 if missing)

Read `package.json`. Verify all three conditions:

1. `signalk.screenshots` exists as a non-empty array.
2. Each path in the array resolves to a real file on disk (`ls <path>` succeeds).
3. Each path is covered by the `files` field (exact match or inside a listed directory).

**Fix:** Add to `package.json`:
```json
"signalk": {
  "screenshots": ["./docs/screenshots/config.png"]
},
"files": ["index.js", "docs/screenshots/"]
```
Then create the image and commit it.

## Check 2 — Changelog (−5 if missing)

Check either condition (either is sufficient):

```bash
ls CHANGELOG.md 2>/dev/null && echo "CHANGELOG.md found"
gh release list --limit 10
```

Pass if `CHANGELOG.md` exists at the repo root, **or** if `gh release list` shows a release
whose tag matches the current version (`v<version>` — e.g., `v0.1.0` for `"version": "0.1.0"`).

**Fix:** Add a `CHANGELOG.md` at the repo root — this is the reliable fix. GitHub Releases
may also satisfy the registry depending on its harness version, but `CHANGELOG.md` is
guaranteed.

## Check 3 — Security audit

Audit the **runtime** dependency tree only. The registry scores the *installed*
plugin, which carries production deps — a `--save-dev` toolchain advisory (e.g. an
`esbuild`/`vitest` CVE) does not ship to users and must not skew the score. A
zero-dep plugin may have no lockfile, which makes `npm audit` fail with `ENOLOCK`
rather than report clean; create one first so the audit can run.

```bash
[ -f package-lock.json ] || npm i --package-lock-only >/dev/null 2>&1
npm audit --omit=dev 2>/dev/null || true
```

`found 0 vulnerabilities` (including the zero-dep case) means clean → full 20 points.

Score impact (runtime deps only):

| Result | Security points | Score penalty |
|--------|----------------|---------------|
| No vulnerabilities | 20 | −0 |
| Moderate only | 15 | −5 |
| Any high | 10 | −10 |
| Any critical | 0 | −20 |

**Fix:** `npm audit fix`. For vulnerabilities in transitive deps you don't control, update
direct deps first. The audit result won't block publishing — you'll just carry the penalty.

## Check 4 — Version already on npm (warning, not scored)

```bash
PKG=$(node -p "require('./package.json').name")
VER=$(node -p "require('./package.json').version")
npm view "$PKG@$VER" version 2>/dev/null
```

If this prints the version string, that version is already on npm. Creating a GitHub Release
will trigger `publish.yml`, which will fail:
`npm error You cannot publish over the previously published versions`

This does not affect the registry score, but CI will fail. If you have changes to ship, bump
the version in `package.json` before cutting a release.

## Output

After all four checks, present a score card:

```
Expected registry score: 95/100
(install/load/activate/schema/tests assumed passing — verify at https://signalk.org/signalk-plugin-registry/)

  ✓ screenshots    no penalty   signalk.screenshots present, files exist, covered by 'files'
  ✗ changelog       −5          no CHANGELOG.md and no GitHub Release for v0.1.0
  ✓ security        no penalty  npm audit clean

  ⚠ v0.1.0 is already on npm — bump version before cutting a release if you have changes to ship
```

Expected score = 100 minus penalties from the checks above (assuming harness checks pass).
