---
name: foolfad-task-state
description: For checking long-running tasks the user dispatched to this machine through Foolfad, including Boondoggle runs launched that way. Use when the user asks about dispatched task status, local worktree state, task logs or output, whether a related command is still alive, or what branch/worktree a dispatched run used.
---

# Foolfad Task State

You are the agent supervising the machine where the dispatched task runs. Inspect local files and processes directly, then answer the user with the concrete status you found.

Foolfad launches a command on this machine using a bare repo and worktree layout.
The local branch is pushed, then a run branch is pushed as:

```text
foolfad/<user>/<run-id>
```

The remote defaults are:

```text
/data/with-runners/repos/<repo-path>/repo.git
/data/with-runners/repos/<repo-path>/worktrees/<user>/<run-id>
/data/with-runners/repos/<repo-path>/foolfad.env
```

Useful environment names are `FOOLFAD_REPO_PATH`, `FOOLFAD_WORKTREE_DIR`, `FOOLFAD_RUN_BRANCH`, and `FOOLFAD_WITH_RUNNERS_DIR`.

## Inspect Local State

List recent Foolfad worktrees:

```bash
root="${FOOLFAD_WITH_RUNNERS_DIR:-/data/with-runners}"
find "$root/repos" -path '*/worktrees/*/*/.git' -printf '%T@ %h\n' 2>/dev/null \
  | sort -nr \
  | head -20
```

Inspect a selected worktree:

```bash
worktree="/data/with-runners/repos/gh/OWNER/REPO/worktrees/user/run-id"
git -C "$worktree" status --short --branch
git -C "$worktree" log -1 --oneline
```

Check recent file activity in a selected worktree:

```bash
find "$worktree" -xdev -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -nr \
  | head -40
```

Look for a running command from that worktree:

```bash
pgrep -af "$worktree" || true
ps -eo pid,ppid,etime,stat,cmd --sort=etime | rg -F "$worktree" || true
```

## Local Branch Clues

When working locally in the source repo, these commands often identify the Foolfad run branch or pushed state:

```bash
git branch --list 'foolfad/*'
git log --all --decorate --oneline --grep='Codex Goal Worktree State' -20
git remote -v
```

Foolfad itself runs commands like:

```bash
foolfad -- npm run dev
foolfad --command 'npm run test'
```

It writes the pushed repo state to a local worktree on this machine and runs the requested command there. If logs are not present as files, say that directly and report the process state, worktree status, last commit, and recent file activity instead.

If the command is a Boondoggle run, read `references/boondoggle.md` for the extra activity and completion signals.
