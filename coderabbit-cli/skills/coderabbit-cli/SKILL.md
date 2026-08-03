---
name: coderabbit-cli
description: Use when running a CodeRabbit CLI (cr) code review — typically as the review gate before opening a pull request. Requires the cr CLI installed and signed in to a CodeRabbit account, and uploads the diff to CodeRabbit's cloud. Covers the mechanics that waste rate-limited reviews when wrong — commit first and scope with --committed and --base-commit, save output to a file, re-read findings without spending a new run, structured --agent output — and gating PR creation on a clean or fully-triaged result.
---

# Driving the CodeRabbit CLI (`cr`) as a pre-PR review gate

The CodeRabbit CLI (`cr`) sends a repo's local diff to CodeRabbit's cloud review service and
prints the findings in the terminal — an independent reviewer you can run *before* a PR exists.
Reviews are rate-limited, so the mechanics below matter: getting them wrong burns a review on
the wrong diff and leaves you waiting out a cooldown.

## Prerequisites — and what leaves the machine

- Requires the `cr` CLI installed and authenticated against a **CodeRabbit account** (sign-in
  via `cr auth login`; `cr auth login --agent` runs an agent-friendly OAuth flow). Depending on
  CodeRabbit's plans, this may be a paid feature — check before adopting it in a workflow.
- **The diff is uploaded to CodeRabbit's cloud for analysis.** Code leaves the machine. For a
  private or proprietary repo, make that call knowingly (policy, NDA, licensing) before the
  first run — and note that files passed as extra context via `-c/--config` are shared too.
- `cr doctor` checks the installation and local review readiness; `cr --version` tells you
  whether the flag claims below still apply.

## Run your own audit first

A rate-limited cloud review is the *second* opinion, not the first. Before spending one, review
the diff yourself with fresh eyes — ideally dispatch a subagent that didn't write the change to
read `git diff <base>...HEAD` cold and try to prove it wrong — fix what survives verification,
and re-run tests. Then `cr` reviews the corrected change instead of re-reporting what you could
have caught locally.

## The mechanics

Verified against `cr` **0.7.1, August 2026** — flags drift between releases; re-check with
`cr review --help` when something errors or behaves differently.

### 1. Commit first; review committed changes

`cr review --committed` reviews only committed changes. Running a review over a dirty tree is
how you get a clean-looking "no findings" that never covered the work you just did (the review
judged a different diff than you think). The reliable agent flow is: commit, then review with
`--committed` — what was reviewed is exactly what ships. (`--uncommitted` and
`--include-untracked` exist for staged/tracked edits, but for a PR gate, commit-first removes
the ambiguity.)

### 2. Pin the base, or the review judges someone else's diff

`--base <branch>` compares against the **local** branch of that name. If local `main` lags
`origin/main`, `cr` attributes the entire already-merged gap to your change — a flood of
alarming findings in files you never touched, all false positives for your scope. Fetch the
base first and prefer pinning an exact commit:

```bash
git fetch origin main
cr review --agent --committed --base-commit "$(git merge-base origin/main HEAD)" \
  2>&1 | tee cr-review-$(git branch --show-current).txt
```

Sanity-check the `Compare:` line in the output against `git diff --stat origin/main...HEAD`;
findings in files outside your real diff are stale-base artifacts, not your problem.

### 3. Save the output the first time — reviews are rate-limited

Hitting the rate limit produces a "try again later" with a cooldown on the order of an hour.
If the first run only streamed to the terminal and scrolled away, that output is gone and a
re-run is blocked. Always `tee` to a file (as above) on the *first* invocation, then work from
the file.

### 4. Re-read the last review without spending a new one

`cr review findings` prints the findings from the previous local review — no new run, no
cooldown hit. Reach for it before ever re-running; a re-run is only warranted when the code
actually changed.

### 5. Output modes

Plain text is the default; there is **no `--plain` flag** (passing it errors). `--agent` emits
structured findings for agent workflows — use it when a tool, not a human, consumes the result.
`--light` runs a reduced-context (cheaper, shallower) review.

### 6. Triage every finding against the current code

Reviews are incremental and can surface points a later commit already fixed. For each finding:
verify it against what is actually in the tree now, fix the still-valid ones, and skip the rest
with a one-line reason (false positive, invariant by design, out of scope). Keep fixes minimal
and re-run tests after.

## Gate the PR on the result

Only open the PR when the `cr` review is clean or every finding is fixed/consciously skipped
with a reason, *and* tests/lint/build are green. In the PR body, state what was actually
verified — "cr review clean, tests green" — not a plan. A reviewer picking up a PR that already
survived an independent audit plus a CodeRabbit pass starts from trust, and the
comment-fix-push round-trips happen before the PR exists instead of on it.

## Gotchas recap

- Account + cloud upload: the diff (and `-c` context files) goes to CodeRabbit's servers.
- Commit first; review with `--committed` — a dirty-tree review can "pass" without seeing your work.
- `--base` resolves **locally**: fetch first, prefer `--base-commit $(git merge-base ...)`.
- Rate-limited: `tee` the first run to a file; `cr review findings` re-reads for free.
- No `--plain` flag — plain is the default; `--agent` for structured output.
- Verified against `cr` 0.7.1 (August 2026); re-verify flags on version drift.
