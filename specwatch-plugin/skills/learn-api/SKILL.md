---
name: learn-api
description: "Complete API learning session - starts Specwatch proxy, guides you to exercise the API endpoints, then aggregates and exports the learned OpenAPI spec into context. Use when you want to capture, reverse-engineer, or record traffic from a new API, or update an existing learned spec."
---

# Learn API

Run a complete Specwatch API learning session for: $ARGUMENTS

## Phase 1: Setup

1. Check for an existing active session:
   ```bash
   npx specwatch status 2>&1
   ```
   If one exists, ask the user whether to stop it first or continue capturing to it.

2. Determine the target URL and session name from $ARGUMENTS. If not provided, ask the user for:
   - Target API URL (e.g., `https://api.example.com`)
   - Session name (e.g., `users-api-v2`)

3. Start the proxy via the bash helper (handles safe word-splitting and PID tracking):
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-start-bg" "<url> --name <session-name> --max-samples 200"
   ```
   Then validate it actually listened (poll the log for up to 10s):
   ```bash
   LOG_FILE=$("$CLAUDE_PLUGIN_ROOT/bin/specwatch-log-path")
   for i in 1 2 3 4 5 6 7 8 9 10; do
     if grep -qF "Specwatch proxy started" "$LOG_FILE" 2>/dev/null; then echo "READY"; break; fi
     if grep -qiE "error|EADDRINUSE|failed|invalid|already active|stop it first|already in use" "$LOG_FILE" 2>/dev/null; then echo "STARTUP_ERROR"; break; fi
     sleep 1
   done
   tail -n 30 "$LOG_FILE"
   ```
   If STARTUP_ERROR or no READY after 10s, run the stop helper to clean up the orphan, report the error to the user, and stop:
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-stop-fg" || true
   ```

## Phase 2: Traffic Capture Guidance

4. Tell the user:
   - The proxy address (e.g., `http://localhost:8080`)
   - How to configure their HTTP client to use the proxy. Specwatch is a reverse proxy, so URLs must be rewritten to point at `localhost:<port>` rather than configured as an HTTP_PROXY env var. Examples:
     - `curl http://localhost:8080/v1/users`
     - In a Node app: `fetch('http://localhost:8080/v1/users')` (rewrite the base URL)
   - Suggest exercising: list endpoints, get single items, create/update/delete, and error cases (404, 400)

5. Stop the turn here and return control to the user. Tell them to either:
   - Re-invoke this skill with the literal word `done` to proceed to aggregation, or
   - Invoke `/specwatch:stop` directly to stop and aggregate manually.
   While they capture traffic, they can check progress at any time with `/specwatch:status`.

## Phase 3: Aggregation and Export

6. Stop the proxy via the helper (liveness-checked, bounded SIGTERM with SIGKILL escalation):
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-stop-fg"
   ```
   Then run aggregation explicitly (nohup prevents the in-process shutdown handler from firing):
   ```bash
   npx specwatch aggregate --name <session-name> 2>&1
   ```

7. Export the spec:
   ```bash
   EXPORT_FILE="${TMPDIR:-/tmp}/specwatch-export.yaml"
   npx specwatch export --name <session-name> --output "$EXPORT_FILE" 2>&1
   ```

8. Read the spec into context using the Read tool on the exported file path.

## Phase 4: Summary

9. Provide a structured summary:
   - Total endpoints discovered
   - HTTP methods observed
   - Confidence scores - flag any endpoints with confidence below 0.6 as needing more traffic
   - Security schemes detected (Bearer, API Key, etc.)
   - Suggested next steps (generate types, write tests, compare with existing spec)
