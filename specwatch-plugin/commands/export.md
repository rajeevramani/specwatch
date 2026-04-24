---
description: "Export the learned OpenAPI spec and read it into context. Usage: /specwatch:export [--name session-name] [--min-confidence 0.5] [--snapshot n]"
argument-hint: "[--name session-name] [--min-confidence 0.5]"
allowed-tools: Bash, Read
---

Export the Specwatch OpenAPI spec and bring it into conversation context.

1. Export to a temp file via the bash helper (the helper handles safe word-splitting of `$ARGUMENTS`):
   ```bash
   OUT="${TMPDIR:-/tmp}/specwatch-export.yaml"
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-exec" export "$ARGUMENTS" --output "$OUT" 2>&1
   echo "OUTPUT_FILE: $OUT"
   ```
   If this fails (no aggregated session, no schemas found), report the error and suggest:
   - Run `/specwatch:stop` first if the proxy is still running
   - Run `npx specwatch aggregate` if the session completed but was not aggregated

2. Check the file was created:
   ```bash
   wc -l "${TMPDIR:-/tmp}/specwatch-export.yaml"
   ```

3. Read the spec into context using the Read tool on the path printed as `OUTPUT_FILE` in step 1.

4. Summarize what was loaded: number of paths, operation count, any security schemes detected.

5. Ask the user what they would like to do with the spec. Common next steps:
   - Generate TypeScript types
   - Write integration tests
   - Explain the API structure
   - Compare with a previous snapshot via `/specwatch:diff`
