---
name: ghwc-worktrees
description: Default custom rules for cloning existing GitHub repos and adding local sibling worktrees on this machine with `ghwc`. Use whenever the user asks to clone an existing GitHub repo, create a sibling worktree, reuse a shared bare clone, or inspect the local shared-clone layout.
---

# ghwc Worktree Workflow

You are the agent supervising this machine. When the user asks about repo setup, clones, or worktrees, act on the local filesystem and report the resulting local paths.

This machine standardises GitHub repos on a shared bare clone plus sibling worktrees under `~/with-runners` by default.

For `OWNER/REPO`, the normal layout is:

```text
~/with-runners/gh/OWNER/REPO/
├── .bare/
├── main/
├── feature-x/
└── other-worktree/
```

Use `ghwc` for existing repositories. It creates or reuses the shared `.bare` clone, fetches with pruning, then adds a worktree.

```bash
ghwc OWNER/REPO
ghwc OWNER/REPO main
ghwc OWNER/REPO feature-x -b feature-x
ghwc OWNER/REPO bugfix --base bugfix
ghwc OWNER/REPO retry-1 -B retry-1
ghwc OWNER/REPO --filter=blob:none
ghwc OWNER/REPO --depth 1
```

## Paths and Flags

- `GHWC_ROOT` overrides the root for `ghwc`; it defaults to `~/with-runners`.
- `--repo-path PATH` overrides the `gh/OWNER/REPO` path under the root.
- `--bare-dir DIR` overrides the shared bare repo path.
- `--base BRANCH` selects the branch used as the starting point. If omitted, the tool resolves the origin default branch, then falls back to `main` or `master`.
- `-b`, `-B`, `--detach`, and `--orphan` are mutually exclusive.
- Clone, fetch, and `git worktree add` flags such as `--filter`, `--depth`, `--jobs`, `--track`, and `--reason` are forwarded. Run `ghwc --help` for the exact list.

The repo parser accepts forms such as `OWNER/REPO`, `github.com/OWNER/REPO`, `git@github.com:OWNER/REPO.git`, and `https://github.com/OWNER/REPO.git`. GitHub repos land under `gh/OWNER/REPO`; less specific URLs fall back to `git/REPO`.
