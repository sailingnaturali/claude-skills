---
name: coderabbit-cli
description: Use when running a CodeRabbit CLI (cr) code review — typically as the review gate before opening a pull request. Requires the cr CLI installed and signed in to a CodeRabbit account, and uploads the diff to CodeRabbit's cloud. Carries the three mechanics that decide whether a rate-limited review counts — commit first (a dirty-tree review judges the wrong diff), pin the base against a stale local branch, and save the output before it's lost — plus the --plain removal trap; the full flag reference is CodeRabbit's own CLI docs.
---

# Driving the CodeRabbit CLI (`cr`) as a pre-PR review gate

The CodeRabbit CLI (`cr`) sends a repo's local diff to CodeRabbit's cloud review service and
prints the findings in the terminal — an independent reviewer you can run *before* a PR
exists. Reviews are rate-limited, so what matters is the three mechanics below: get one wrong
and the run either judges the wrong diff or its output is gone. For the full command and flag
reference, use [CodeRabbit's CLI docs](https://docs.coderabbit.ai/cli/overview) — this skill
deliberately carries only what those docs don't.

## Prerequisites — and what leaves the machine

- Requires the `cr` CLI installed and authenticated against a **CodeRabbit account** — sign in
  with `cr auth login` (0.7.1's own `--help` additionally offers `cr auth login --agent` for
  an agent-driven OAuth flow). Rate limits and pricing are plan-dependent — check before
  wiring it into a workflow.
- **The diff is uploaded to CodeRabbit's cloud for analysis.** Code leaves the machine. For a
  private or proprietary repo, make that call knowingly (policy, NDA, licensing) — and note
  that files passed as extra context via `-c/--config` are shared too.
- `cr doctor` checks the installation and review readiness; `cr --version` tells you whether
  the claims below still apply.

## Run your own audit first

A rate-limited cloud review is the *second* opinion, not the first. Before spending one,
review the diff yourself with fresh eyes — ideally dispatch a subagent that didn't write the
change to read `git diff <base>...HEAD` cold and try to prove it wrong — fix what survives
verification, and re-run tests. Then `cr` reviews the corrected change instead of
re-reporting what you could have caught locally.

## The three mechanics that decide whether a run counts

### 1. Commit first — a dirty-tree review judges the wrong diff

`cr review --committed` reviews only committed changes. Running a review over a dirty tree
is how you get a clean-looking "no findings" that never covered the work you just did. The
reliable agent flow: commit, then review with `--committed` — what was reviewed is exactly
what ships.

### 2. Pin the base — or the review judges someone else's diff

`--base <branch>` compares against the **local** branch of that name. If local `main` lags
`origin/main`, `cr` attributes the entire already-merged gap to your change — a flood of
alarming findings in files you never touched, all false positives for your scope. Fetch the
base first and pin an exact commit:

```bash
git fetch origin main
cr review --agent --committed --base-commit "$(git merge-base origin/main HEAD)" \
  | tee "${TMPDIR:-/tmp}/cr-review-$(git branch --show-current | tr '/' '-').txt"
```

Sanity-check the `Compare:` line in the output against `git diff --stat origin/main...HEAD`;
findings in files outside your real diff are stale-base artifacts, not your problem.

### 3. Save the output the first time — you may not get another run

Rate limits are **plan-dependent** — free tiers are reported in the a-few-per-hour/day range,
and even a paid plan paces back-to-back runs (observed: a ~2-minute enforced wait after
several runs in one day). Treat every run as unrepeatable:

- `tee` the **first** invocation to a file (as above) and work from the file.
- **Sanitize the filename and write outside the repo.** A slashed branch name
  (`feat/foo`) inside the path makes `tee` fail with "No such file or directory" — losing
  the output of the one run you can't cheaply repeat — hence the `tr '/' '-'`. Writing
  under `${TMPDIR:-/tmp}` also keeps the file from appearing as an untracked path that a
  later `--include-untracked` run would review.
- **With `--agent`, don't fold stderr into the pipe.** `--agent` emits structured findings
  for a tool to parse; `2>&1` interleaves progress and warning lines into that stream. Plain
  `| tee file` keeps stdout clean — add `2> file.err` separately if you want the noise.
- `cr review findings` re-prints the previous review with **no new run** — reach for it
  before ever re-running; a re-run is only warranted when the code actually changed.

## Output modes — and the `--plain` trap

Plain text is the default mode. The `--plain` flag that older docs and examples show is
**gone as of 0.7.x** — verified: `cr review --plain` → `error: unknown option '--plain'`
(0.7.1; the run doesn't happen, so it costs nothing, but scripts relying on it break).
`--agent` emits structured findings for agent workflows; `--light` runs a lighter review
with reduced context work (faster).

## Triage, then gate the PR

Verify each finding against what is actually in the tree now — reviews are incremental and
can surface points a later commit already fixed, and findings can simply be wrong: check
against captured evidence before obeying. Fix the still-valid ones; skip the rest with a
one-line reason. Only open the PR when the review is clean or fully triaged *and*
tests/lint/build are green — and let the PR body state what was verified, not a plan.

---

*The three mechanics and the `--plain` removal verified against `cr` **0.7.1** (August 2026),
distilled from daily use. For everything else — current flags, commands, auth options — read
[CodeRabbit's CLI docs](https://docs.coderabbit.ai/cli/overview) first; that reference is
theirs to keep current, and this skill deliberately doesn't duplicate it.*
