---
name: terry-task-state
description: For checking-in on long-run autonomous Codex tasks dispatched to the local device from the users remote device. Use when asks about status for remotely dispatched tasks (sometimes called a boondoggle), boondoggle worktree state, boondoggle logs, or whether a dispatched command is still alive.
---

# Terry Task State

Your operator can dispatch agents to perform long-running tasks on this computer, within worktrees, under `/home/$USER/with-runners/gh/<org>/<repo>/<worktree>` for GitHub repos. Each worktree has `.terry-run/run.pid` and `.terry-run/logs/*.log`.

This layout is deliberate: each worktree is one long-running autonomous Codex run, with its own branch and logs. 

These worktrees represent different attempts or versions of work. 

Use pidfile mtime as start time. Use newest log mtime as last activity. If `kill -0 "$pid"` succeeds, the task is still active.

## All Task Status

```bash
root="${TERRY_WITH_RUNNERS_DIR:-/home/${USER:-$(id -un)}/with-runners}"

while IFS= read -r -d '' pid_file; do
  worktree="${pid_file%/.terry-run/run.pid}"
  pid="$(tr -dc '0-9' < "$pid_file")"
  started="$(stat -c '%y' "$pid_file" 2>/dev/null | cut -d. -f1)"
  log_file="$(find "$worktree/.terry-run/logs" -type f -name '*.log' -printf '%T@ %p\0' 2>/dev/null | sort -z -nr | head -z -n 1 | cut -z -d' ' -f2- | tr -d '\0')"
  last_seen="no-log"
  [[ -n "$log_file" ]] && last_seen="$(stat -c '%y' "$log_file" 2>/dev/null | cut -d. -f1)"

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    status="active"
  else
    status="stopped"
  fi

  printf '%-8s pid=%-8s start=%s last=%s worktree=%s\n' "$status" "${pid:-?}" "${started:-?}" "$last_seen" "$worktree"
done < <(find "$root" -path '*/.terry-run/run.pid' -print0 2>/dev/null)
```

## Recent Tasks

List first `N` worktrees ranked by newest log mtime, falling back to pidfile mtime.

```bash
root="${TERRY_WITH_RUNNERS_DIR:-/home/${USER:-$(id -un)}/with-runners}"
n="${1:-10}"

while IFS= read -r -d '' pid_file; do
  worktree="${pid_file%/.terry-run/run.pid}"
  pid="$(tr -dc '0-9' < "$pid_file")"
  latest_log_ts="$(find "$worktree/.terry-run/logs" -type f -name '*.log' -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1)"
  latest_ts="${latest_log_ts:-$(stat -c '%Y' "$pid_file" 2>/dev/null)}"

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    status="active"
  else
    status="stopped"
  fi

  printf '%s\t%-8s\tpid=%s\t%s\n' "$latest_ts" "$status" "${pid:-?}" "$worktree"
done < <(find "$root" -path '*/.terry-run/run.pid' -print0 2>/dev/null) \
  | sort -nr \
  | head -n "$n" \
  | while IFS=$'\t' read -r ts status pid worktree; do
      human="$(date -d "@${ts%.*}" '+%F %T' 2>/dev/null || printf '?')"
      printf '%s  %-8s  %s  %s\n' "$human" "$status" "$pid" "$worktree"
    done
```

For a chosen worktree, inspect the newest log with `ls -t "$worktree/.terry-run/logs"/*.log | head -n 1`.

For each run the user asks about, also consider:

```bash
git -C "$worktree" status --short --branch
git -C "$worktree" log -1 --oneline
log_file="$(ls -t "$worktree/.terry-run/logs"/*.log 2>/dev/null | head -n 1)"
[[ -n "$log_file" ]] && sed -n '1,40p' "$log_file"
```
