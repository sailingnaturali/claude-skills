---
name: npm-oidc-publish
description: Use when publishing an npm package from GitHub Actions with OIDC trusted publishing (no NPM_TOKEN, no OTP in CI) — the release-triggered workflow, the new-package first-publish chicken-and-egg, configuring the trusted publisher, and the registry-propagation 404 gotcha.
---

# Publish to npm with OIDC trusted publishing

npm "trusted publishing" lets a GitHub Actions workflow `npm publish` **without a long-lived
`NPM_TOKEN`** — it authenticates via OIDC and stamps provenance automatically. Works for any
package; nothing language- or framework-specific.

## The workflow

`.github/workflows/publish.yml`:
```yaml
name: publish
on: { release: { types: [published] } }
permissions:
  contents: read
  id-token: write      # <- this is what enables OIDC
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }   # npm >= 11.5 supports OIDC; node 24 is safe
      - run: npm ci                    # needs a committed package-lock.json
      - run: npm test
      - run: npm publish               # no token, no --otp; provenance is automatic
```
- Scoped public package? add `"publishConfig": { "access": "public" }` to `package.json` (and a `"files"` array so the build actually ships).
- A TypeScript build runs via `"prepare": "npm run build"` on `npm publish`.

## The chicken-and-egg (every *new* package hits this)

You **cannot** configure a trusted publisher for a package that doesn't exist on npm yet, and
the OIDC publish needs that config to exist. So the **first** publish is manual:

1. `npm publish` locally → enter your 2FA **OTP** (`npm publish --otp=<code>`). This creates `0.1.0`.
2. On npmjs.com → the package → **Settings → Trusted Publisher → GitHub Actions**: set the
   repo (`owner/repo`), the **workflow filename** (`publish.yml`), and leave the environment
   blank (unless you actually use one).
3. From then on it's hands-free: **`gh release create vX.Y.Z --notes "..."`** triggers the
   workflow and publishes via OIDC.

If the workflow's `npm publish` fails with **`ENEEDAUTH`** ("requires you to be logged in"),
the trusted publisher isn't configured yet, or the workflow filename / repo doesn't match what
you registered on npm — it's a config problem, not code. (`npm ci` + `npm test` passing then
`npm publish` failing is the tell.)

## Gotcha: registry propagation lag

After a successful publish (npm prints `+ <pkg>@<ver>`), the npmjs.com **website** shows the
package immediately, but the public **registry API** (`registry.npmjs.org/<pkg>`, `npm view`)
can return **404 for a few minutes** for a brand-new package — worst for a *scoped* package's
first publish. That 404 is propagation, not a failed publish. Trust the `+ <pkg>@<ver>` line;
the website is authoritative meanwhile.

## Verify

```bash
# watch the publish run to completion
gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
# then (may lag a few min for a new package):
npm view <pkg> version
```
