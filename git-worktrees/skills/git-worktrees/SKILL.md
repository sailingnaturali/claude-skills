---
name: git-worktrees
description: Use when multiple sessions work the same repo in parallel — several agent/dev sessions, a long-running review or build that must not be disturbed, or a quick look at another branch or PR. git worktree gives every branch its own directory (own node_modules, own build output) over one shared object store, and git itself enforces that a branch is checked out in at most one place. Covers add/list/remove/prune, per-worktree installs, the rm -rf stale-registration gotcha, and why worktrees and scratch checkouts belong on disk-backed paths, never tmpfs /tmp.
---

# Parallel branches with git worktrees

One working copy can have one checked-out branch. The moment a second session needs the same
repo — another agent working a second task, a background review or build you must not disturb,
a quick fix while a feature is mid-flight — you either wait, stash-juggle, or silently fight:
a checkout under a running process, `node_modules` half-rebuilt for the other branch, test
output from a mix of both. `git worktree` ends that: extra working directories over the same
repository, each with its own branch, files, and installs.

## The rules that matter

- **Create a sibling directory, named `<repo>-<topic>`:**

  ```bash
  git worktree add ../myrepo-featurex -b featurex origin/main
  ```

  The path lives *outside* the main checkout. Everything git-tracked appears there; the object
  store, branch and remote-tracking refs, and stashes stay shared — a `git fetch` in any
  worktree is visible in all of them — while each worktree keeps its own `HEAD` and index.
  Disk cost is one checkout plus its installs, not a second clone.

  The last argument is the *start point*, and it has to be a ref that exists locally. A plain
  clone has only `origin`, so `origin/main` is the safe default; on a fork you also have
  `upstream`, and branching off the true upstream (`upstream/main`) rather than your fork's
  stale mirror is usually what you want. Substitute the remote and the default branch to
  match the repo — `git remote` and `git branch -r` tell you what exists. A start point that
  does not resolve fails the command outright with
  `fatal: invalid reference: <remote>/<branch>`, so this is a typo you find immediately, not
  one that silently branches off the wrong base.

- **One branch ↔ one worktree, enforced.** Checking out a branch that another worktree holds
  fails: `fatal: '<branch>' is already used by worktree at '<path>'`. That refusal is the feature —
  it turns two-sessions-on-one-branch from a silent fight into a loud error (`--force` can
  override it; don't, for exactly that reason). To *inspect* the same commit twice, use a
  detached worktree instead:

  ```bash
  git fetch origin pull/17/head
  git worktree add ../myrepo-pr17 --detach FETCH_HEAD   # review a PR, touch nothing
  ```

- **Nothing gitignored comes along.** A fresh worktree has no `node_modules`, no `dist`, no
  `.env` — run the install (`npm install`, etc.) *in each worktree* and copy env files
  yourself. That per-worktree install is the point, not overhead: each branch keeps the
  dependency tree its lockfile/manifest describes, and switching work never clobbers the other
  session's `node_modules` or build output mid-run.

- **Remove with git, not `rm -rf`.**

  ```bash
  git worktree remove ../myrepo-featurex
  ```

  An `rm -rf`'d worktree stays registered — `git worktree list` keeps showing it (marked
  `prunable`) and the branch stays locked to it. `git worktree prune` clears stale
  registrations when it happens anyway.

- **Put worktrees on a disk-backed path — never `/tmp`.** Check with
  `findmnt -no FSTYPE /tmp`: on typical Linux it prints `tmpfs`, i.e. RAM (7.8 G total on the
  machine this was verified on). One `node_modules` install there eats gigabytes of memory,
  and a reboot deletes the lot. Use a real directory (`~/dev/...`, `~/work/...`). The same
  applies to any scratch clone or build dir.

## The parallel-session workflow

Give **each concurrent session its own worktree** and never let two sessions share a working
directory:

- Session A holds the main checkout on `feature-x` with a long-running process (a cloud code
  review, a watch build, a test soak) — nobody touches that directory until it finishes.
- Session B gets `../repo-topic-b`, its own branch, its own install, its own builds.
- A third need (hotfix, PR review) gets a third worktree; `git worktree list` shows the whole
  fleet at a glance.

This composes especially well with agent sessions: agents create worktrees cheaply, the
branch-exclusivity rule makes any accidental overlap fail loudly, and cleanup is one
`git worktree remove`. Distilled from real use:
one marketplace repo, three PR branches in flight at once — main checkout plus two worktrees —
with a background review running in one directory while the next skill was written in another.
The isolation covers working directories and indexes; refs, remotes, and stashes remain
shared, so branch-level coordination is still on you.

---

*Verified against git 2.47 (Linux), August 2026: the branch-exclusivity refusal, shared
refs/objects across worktrees, `prunable` marking after an out-of-band delete plus
`git worktree prune` recovery, and `/tmp` as 7.8 G tmpfs on the test machine.*
