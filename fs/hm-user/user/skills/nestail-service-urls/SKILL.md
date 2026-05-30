---
name: nestail-service-urls
description: Use when the user asks to view, open, test, share, or find the URL for a running web service or dev server from this environment. Convert localhost dev-server URLs through Nestail using Bash `$HOSTNAME`: `http://$HOSTNAME/<port>/<rest-of-url>`. Do this instead of giving `localhost:<port>` links.
---

# Nestail Service URLs

You are the agent supervising this machine. When the user asks to view a service, translate local dev-server ports into URLs the user can open from their side.

Nestail exposes local web services through the system hostname. When a dev server is running on `localhost:<port>`, present the user with:

```text
http://<HOSTNAME>/<port>/<rest-of-url>
```

Get the hostname from Bash `$HOSTNAME`:

```bash
printf '%s\n' "$HOSTNAME"
```

If `$HOSTNAME` is empty, fall back to:

```bash
hostname
```

Examples:

```text
http://localhost:3000/        -> http://$HOSTNAME/3000/
http://127.0.0.1:5173/app     -> http://$HOSTNAME/5173/app
http://localhost:8000/a?x=1   -> http://$HOSTNAME/8000/a?x=1
```

Do not tell the user to open `localhost:<port>` unless they explicitly ask for the container-local URL. For user-facing links, replace the local origin with the Nestail URL shape.

## Workflow

1. Identify the service port from the dev server output, config, or command.
2. Verify it responds locally when practical:

```bash
curl -fsS -I "http://localhost:$PORT/" >/dev/null
```

3. Read `$HOSTNAME` from Bash.
4. Give the user `http://$HOSTNAME/$PORT/` with any path, query string, or hash preserved after the port segment.

Nestail routes the first path segment as the target localhost port, so the Nestail URL has the port in the path, not after the hostname.
