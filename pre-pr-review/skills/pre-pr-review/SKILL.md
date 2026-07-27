---
name: pre-pr-review
description: Use before opening a pull request to catch defects while they are still cheap — first self-audit the change like an adversarial auditor (not the author who just wrote it), then run a CodeRabbit CLI review, and only open the PR once both are clean. Covers the auditor mindset, driving the `cr` CLI (structured output to a file, the rate-limit and committed-only gotchas), and gating PR creation on the result.
---

# Audit, then CodeRabbit-review, then open the PR

The cheapest place to catch a bug is before anyone else reads the diff. Two independent passes
before you open the PR — a self-audit with an auditor's mindset, then a CodeRabbit CLI review —
find different classes of defect, and a green result on both is the gate for `gh pr create`. This
is not a substitute for tests; run those too. It is the review layer that stops "looks right to
the author" from reaching a reviewer.

## 1. Self-audit like an adversarial auditor, not the author

The author who just wrote the code is the worst person to review it — they see what they
intended, not what they wrote. Switch stance: assume the change is wrong and try to prove it.

- **Prefer a fresh perspective.** Dispatch a subagent (or a separate review pass) to audit the
  diff cold, without the narrative of how it was built. It will not share your blind spots.
- **Review the diff, not your memory of it.** `git diff <base>...HEAD` and read what is actually
  there — including whitespace, deletions, and the lines you "didn't really change".
- **Hunt the classes static review misses.** The high-value defects this session's kind of work
  turns up are rarely on the changed line itself:
  - **Teardown / lifecycle races** — an operation (a timer, an async callback, a queued write)
    that fires *after* stop/cleanup/removal and touches state that was just torn down.
  - **State that can go stale or diverge** — two places tracking the same fact; an idempotent
    "update" that no-ops when the value changed and leaves the old one live.
  - **Every raise needs a clear, every add needs a remove** — resources, notifications,
    listeners, timers, temp files created on one path but not released on all exit paths.
  - **Boundary inputs** — empty, missing, unusual characters, the value that makes a path or key
    collide, the older/newer peer that lacks a field.
  - **Error paths** — does a throw mid-sequence leave partial state? Is a catch swallowing
    something that should surface?
- **Verify findings before acting.** An audit that reports plausible-but-wrong issues wastes the
  fix. For each finding, trace a concrete input/state to a concrete wrong output before you
  change anything — and for anything non-trivial, have the verification done by a *different*
  pass than the one that raised it (adversarial: default to "refuted" unless it genuinely
  reproduces).
- Fix what survives verification; re-run tests. Only then move to step 2.

## 2. CodeRabbit CLI review (`cr`)

CodeRabbit's local CLI reviews the diff against its own model — a second, independent opinion.
The mechanics have sharp edges; get them right or you waste a review.

- **It only sees committed changes.** `cr` reviews commits, not your working tree — run
  `git commit` first, or it reports "No files to review". Use `--committed` to review only
  committed changes, and `--base-commit <sha>` (or `--base <branch>`) to scope the comparison to
  exactly your change rather than a stale local base.
- **Always save the output to a file — it is rate-limited.** A fresh review has a cooldown
  (often tens of minutes); if you lose the output you cannot just re-run. Pipe it and keep it:

  ```bash
  # structured findings for an agent to consume, saved so a rerun isn't needed:
  cr review --agent --committed --base-commit "$(git merge-base origin/main HEAD)" \
    | tee /tmp/cr-review-<branch>.txt
  ```

  `--agent` emits structured findings meant for agent workflows; drop it for the plain
  human-readable default (there is no `--plain` flag in current versions — plain text is the
  default mode). Either way, `tee` to a file so the result survives.
- **Re-read the last review without spending a new one.** If you already ran a review and just
  need the findings again, `cr review findings` prints the previous local review's findings — no
  new run, no cooldown hit. Reach for this before re-running.
- **The base can be stale.** `cr`'s comparison may use a local base that lags the remote; confirm
  the diff it's judging matches `git diff origin/main...HEAD`, and pass `--base-commit`
  explicitly when in doubt.
- **Triage every finding against the current code.** Verify each against what's actually there
  now (a prior fix may already cover it — the CLI reviews incrementally and can surface stale
  points), fix the still-valid ones, and skip the rest with a one-line reason (invariant by
  design, false positive, out of scope). Keep changes minimal; re-validate (build/tests/lint).

## 3. Only open the PR when both are clean

Treat a clean audit **and** a clean (or fully-triaged) `cr` review as the precondition for
`gh pr create`, alongside green tests/lint:

1. Self-audit clean (all survivors fixed).
2. `cr` review clean, or every finding resolved/consciously skipped with a reason.
3. Tests, lint, and build green.
4. *Then* open the PR — and in the body, state what was verified (not a plan): tests run, e2e if
   applicable, "self-audit + cr review clean". List only what actually happened.

A reviewer opening a PR that already passed an adversarial self-audit and a CodeRabbit pass
starts from a much higher base of trust — and the round-trips you'd have spent on
review-comment-fix-push happen before the PR exists.

## Gotchas recap

- The author's own eyes are the weakest review — audit cold, ideally from a fresh pass.
- Hunt lifecycle/teardown races and stale/divergent state, not just the changed line.
- Verify a finding reproduces before fixing it; refute by default.
- `cr` reviews **committed** changes only — commit first.
- `cr` is **rate-limited** — always `tee` the output to a file; use `cr review findings` to
  re-read without a new run.
- No `--plain` flag — plain text is the default; `--agent` gives structured findings.
- PR creation is gated on clean audit + clean cr + green tests, not on any one of them.
