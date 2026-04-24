---
description: "Show the current Specwatch proxy status - active session, sample count, target URL, and port."
allowed-tools: Bash
---

Show the current Specwatch session status.

1. Check session status:
   ```bash
   npx specwatch status 2>&1 || echo "No active session"
   ```

2. Check if the background proxy process is still running:
   ```bash
   PID=$("$CLAUDE_PLUGIN_ROOT/bin/specwatch-pid-read")
   if [ -n "$PID" ]; then
     kill -0 "$PID" 2>/dev/null && echo "Proxy process running (PID $PID)" || echo "Proxy process not running (stale PID)"
   else
     echo "No proxy PID tracked"
   fi
   ```

Report the session information to the user clearly. If no active session, suggest `/specwatch:start <url>`.
