---
description: "Stop the running Specwatch proxy and trigger aggregation."
allowed-tools: Bash
---

Stop the running Specwatch proxy and aggregate the captured traffic.

Note: When the proxy runs as a background process (via nohup), the SIGTERM shutdown handler does not trigger aggregation. The stop command must run `specwatch aggregate` explicitly after killing the process.

1. Stop the proxy via the bash helper. The helper performs a liveness check, sends SIGTERM, waits up to 30s, and escalates to SIGKILL if needed:
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-stop-fg"
   ```
   The helper prints `STATE=...` lines indicating what happened (no_pid_tracked, stale_pid, killing, stopped_after=Ns, killed_via_sigkill).

2. Run aggregation explicitly (required because nohup prevents the in-process shutdown handler from firing):
   ```bash
   npx specwatch aggregate 2>&1
   ```

3. Show the aggregation results to the user and tell them they can now run `/specwatch:export` to bring the spec into context.
