# Boondoggle Runs

Use this reference when the dispatched Foolfad command is `boondoggle` or the user asks about a boondoggle.

Boondoggle runs a Codex goal from a prompt on stdin. It is often launched through Foolfad, so the worktree and branch still follow the Foolfad layout:

```text
/data/with-runners/repos/<repo-path>/worktrees/<user>/<run-id>
foolfad/<user>/<run-id>
```

## Activity Signals

Boondoggle does not write a `run.pid` file in the current `tissloolly` package. It keeps child PIDs in shell variables for cleanup while the script is running.

When `/.sprite/api.sock` exists, Boondoggle publishes a Sprite heartbeat:

- Task name: `SPRITE_TASK_NAME`, or a normalized name derived from the prompt.
- Expiry: `SPRITE_TASK_EXPIRE`, default `5m`.
- Heartbeat interval: `SPRITE_HEARTBEAT_INTERVAL`, default `60` seconds.

Treat Sprite heartbeat as an activity signal when available. If there is no accessible Sprite state, use process state, worktree state, last commit, and recent file activity.

Useful local checks:

```bash
worktree="/data/with-runners/repos/gh/OWNER/REPO/worktrees/user/run-id"
pgrep -af 'boondoggle|codex app-server|codex' || true
ps -eo pid,ppid,etime,stat,cmd --sort=etime | rg -F "$worktree" || true
ps -eo pid,ppid,etime,stat,cmd --sort=etime | rg 'boondoggle|codex app-server' || true
git -C "$worktree" status --short --branch
git -C "$worktree" log -5 --decorate --oneline
find "$worktree" -xdev -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -40
```

## Completion Signals

Boondoggle commits and pushes worktree changes when configured to publish goal success, goal failure, or unexpected exit. Its default commit subject starts with:

```text
Codex Goal Worktree State: status=<status>
```

The commit body records prompt length, task name, status, exit status, Codex thread id, and UTC time.

Use these git checks to identify the latest published outcome:

```bash
git -C "$worktree" log --decorate --oneline --grep='Codex Goal Worktree State' -20
git -C "$worktree" log -1 --format=fuller
```

## Reporting

Tell the user what you can verify:

- Whether a related process is still running.
- Whether Sprite heartbeat is available and current, if you can inspect it.
- Current worktree branch, status, and last commit.
- Latest Boondoggle status commit if present.
- Recent file activity.

If there is no pidfile, say there is no pidfile for this current runner instead of implying one is missing.
