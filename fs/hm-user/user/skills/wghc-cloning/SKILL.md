---
name: wghc-cloning
description: Default custom rules for git cloning on this machine — covers worktree-friendly clones via `wghc`, ongoing worktree management against a shared `.bare` repo, and creating new GitHub repos in the same structure. Use whenever you need to clone, add a sibling worktree, or set up a brand-new repo locally.
---

# wghc + .bare worktree workflow

This machine standardises every git clone on a **bare repo + worktree** layout under `$WGH_ROOT` (default `~/with-runners`). The `wghc` command wraps `gh repo clone` + `git worktree add` so you never end up with a "main checkout" that other worktrees have to compete with — `main`/`master` is just another sibling worktree off the shared `.bare/`.

The layout for any repo (`OWNER/REPO`) is:

```
~/with-runners/gh/OWNER/REPO/
├── .bare/             # shared bare clone, the actual git database
├── main/              # worktree for the default branch
├── feature-x/         # worktree for branch `feature-x`
└── any-other-branch/  # one worktree per concurrent line of work
```

All worktrees share the same `.bare`, so fetches are deduplicated and disk usage stays sane even with many concurrent runs (e.g. one per Terry boondoggle).

## Cloning an existing repo

First-time clone of `OWNER/REPO` (creates `.bare/` and a default-branch worktree):

```bash
wghc OWNER/REPO            # worktree dir defaults to repo name
wghc OWNER/REPO main       # explicit worktree dir name
```

Add a sibling worktree on a new branch off the default branch:

```bash
wghc OWNER/REPO feature-x -b feature-x
```

Add a worktree on an existing remote branch:

```bash
wghc OWNER/REPO bugfix --base bugfix
```

Reset/force a branch to start from default branch and add a worktree:

```bash
wghc OWNER/REPO retry-1 -B retry-1
```

Shallow clone for big repos (forwards to `git clone`/`git fetch`):

```bash
wghc OWNER/REPO --filter=blob:none
wghc OWNER/REPO --depth 1
```

If `.bare/` already exists from a previous `wghc`, subsequent invocations skip the clone, run `git fetch --prune`, then add the new worktree.

## Creating a brand-new repo in this structure

Create the remote first, then `wghc` it locally so the layout is identical to any cloned repo:

```bash
gh repo create OWNER/NEW-REPO --private --add-readme --clone=false
wghc OWNER/NEW-REPO main
```

`--clone=false` is important — let `wghc` do the clone so you get `.bare/` + a worktree, not a plain checkout. After that, add work-in-progress worktrees the usual way:

```bash
wghc OWNER/NEW-REPO feature-x -b feature-x
```

If you have local code you want as the initial commit, do the create-and-wghc above, then `cd ~/with-runners/gh/OWNER/NEW-REPO/main`, copy your files in, commit, push.

## Notes & flags

- `WGH_ROOT` env var overrides the root dir (default `~/with-runners`).
- `--repo-path PATH` overrides the `gh/OWNER/REPO` sub-path under root.
- `--base BRANCH` picks which remote branch to base a new worktree on (defaults to the origin's HEAD).
- `--detach`, `--orphan`, `-b`, `-B` are mutually exclusive (one branch-mode per invocation).
- Most `git clone` / `git fetch` / `git worktree add` flags are forwarded — see `wghc --help`.
- The path-derivation logic accepts any of: `OWNER/REPO`, `github.com/OWNER/REPO`, `git@github.com:OWNER/REPO.git`, `https://github.com/OWNER/REPO[.git]`, etc. Non-GitHub URLs land under `git/<reponame>/` instead of `gh/<owner>/<repo>/`.

## Why this layout

- Concurrent autonomous runs (see `terry-task-state`) live in sibling worktrees. Each can be on its own branch without stepping on a "main checkout."
- Deleting a failed attempt is `rm -rf <worktree>/ && git -C .bare worktree prune` — no risk of nuking the shared history.
- New repos created in the same shape mean tooling that traverses `~/with-runners` (Terry, status scripts) keeps working uniformly across cloned and freshly-created repos.
