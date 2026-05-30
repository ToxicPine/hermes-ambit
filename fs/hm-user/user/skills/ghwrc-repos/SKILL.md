---
name: ghwrc-repos
description: Default custom rules for creating new GitHub repos on this machine with `ghwrc`. Use whenever the user asks to create a new GitHub repository, initialize a new repo in the shared bare-clone/worktree layout, or create the remote and local worktree together.
---

# ghwrc Repo Creation Workflow

You are the agent supervising this machine. When the user asks to create a GitHub repo, create the remote and local worktree from here, then report the resulting repo URL and local path.

`ghwrc` creates the GitHub repository, then creates or reuses the local shared bare clone and adds a worktree under `~/with-runners` by default.

For `OWNER/REPO`, the normal layout is:

```text
~/with-runners/gh/OWNER/REPO/
├── .bare/
└── main/
```

Always pass exactly one visibility flag:

```bash
ghwrc --private OWNER/NEW-REPO main
ghwrc --public --add-readme OWNER/NEW-REPO main
ghwrc --internal OWNER/NEW-REPO main
```

Common creation options:

```bash
ghwrc --private --description "Short description" OWNER/NEW-REPO main
ghwrc --public --add-readme --license mit OWNER/NEW-REPO main
ghwrc --private --template OWNER/TEMPLATE OWNER/NEW-REPO main
ghwrc --private OWNER/NEW-REPO feature-x -b feature-x
```

If the new repo has no initial content and no explicit branch mode, `ghwrc` creates an orphan worktree so there is somewhere to make the first commit.

## Paths and Flags

- `GHWRC_ROOT` overrides the root; it defaults to `~/with-runners`.
- `--repo-path PATH` overrides the `gh/OWNER/REPO` path under the root.
- `--bare-dir DIR` overrides the shared bare repo path.
- `--base BRANCH` selects the branch used as the starting point when the repo has initial content.
- `-b`, `-B`, `--detach`, and `--orphan` are mutually exclusive.
- Repository creation flags such as `--description`, `--homepage`, `--team`, `--template`, `--add-readme`, `--gitignore`, and `--license` are forwarded to `gh repo create`.
- Clone, fetch, and `git worktree add` flags such as `--filter`, `--depth`, `--jobs`, `--track`, and `--reason` are forwarded. Run `ghwrc --help` for the exact list.

The repo parser accepts forms such as `OWNER/REPO`, `github.com/OWNER/REPO`, `git@github.com:OWNER/REPO.git`, and `https://github.com/OWNER/REPO.git`. GitHub repos land under `gh/OWNER/REPO`; less specific names fall back to `git/REPO`.
