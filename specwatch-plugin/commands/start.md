---
description: "Start Specwatch proxy to capture API traffic. Usage: /specwatch:start <url> [--port 8080] [--name session-name] [--max-samples 200] [--auto-aggregate]"
argument-hint: "<target-url> [--port 8080] [--name session-name]"
allowed-tools: Bash
---

Start the Specwatch proxy for the target URL provided in $ARGUMENTS.

Run the following steps:

1. Refuse to proceed if no arguments were provided. The first argument must be a target URL:
   ```bash
   ARGS="$ARGUMENTS"
   if [ -z "$ARGS" ]; then
     echo "ERROR: target URL required. Usage: /specwatch:start <url> [flags]"
     exit 1
   fi
   ```
   If this prints ERROR, stop and ask the user for the URL. Do not invoke specwatch.

2. Check if a Specwatch proxy is already running. If so, do not start a second one:
   ```bash
   PID=$("$CLAUDE_PLUGIN_ROOT/bin/specwatch-pid-read")
   if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
     echo "ALREADY_RUNNING:$PID"
   else
     [ -n "$PID" ] && "$CLAUDE_PLUGIN_ROOT/bin/specwatch-pid-clear"
     echo "NOT_RUNNING"
   fi
   ```
   If ALREADY_RUNNING, report the existing session is active and stop.

3. Start Specwatch via the bash helper. The helper is responsible for word-splitting the args (slash commands may run under zsh which does not word-split unquoted vars by default) and tracking the PID:
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-start-bg" "$ARGUMENTS"
   ```
   Capture the printed `PID=...` and `LOG=...` values for the next step.

4. Validate the proxy actually listened. Poll the log for up to 10s:
   ```bash
   LOG_FILE=$("$CLAUDE_PLUGIN_ROOT/bin/specwatch-log-path")
   for i in 1 2 3 4 5 6 7 8 9 10; do
     if grep -qF "Specwatch proxy started" "$LOG_FILE" 2>/dev/null; then
       echo "READY"
       break
     fi
     if grep -qiE "error|EADDRINUSE|failed|invalid|already active|stop it first|already in use" "$LOG_FILE" 2>/dev/null; then
       echo "STARTUP_ERROR"
       break
     fi
     sleep 1
   done
   tail -n 30 "$LOG_FILE"
   ```

5. If STARTUP_ERROR or no READY detected after 10s, the proxy did not come up. Clean up and report:
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-stop-fg" || true
   ```
   Report the error to the user (port in use, invalid URL, existing active session) and stop.

6. On READY, report to the user:
   - Confirm the proxy started and which port it is listening on (from the log output)
   - Remind them to point their HTTP client at `http://localhost:<port>` instead of the original API URL
   - Tell them to run `/specwatch:stop` when done capturing
