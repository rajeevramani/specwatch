---
description: "Diff two Specwatch snapshots or sessions to detect breaking API changes. Usage: /specwatch:diff [--name session --snapshots n1 n2] or [session1-id session2-id]"
argument-hint: "--name <session> --snapshots <n1> <n2>"
allowed-tools: Bash
---

Compare two Specwatch snapshots or sessions to detect breaking API changes.

1. If no arguments provided in $ARGUMENTS, list available sessions and snapshots to help the user choose:
   ```bash
   npx specwatch sessions list 2>&1
   ```
   Then for the most recent session:
   ```bash
   npx specwatch snapshots 2>&1
   ```
   Ask the user which sessions/snapshots to compare before proceeding.

2. Run the diff via the bash helper (handles safe word-splitting of `$ARGUMENTS`):
   ```bash
   "$CLAUDE_PLUGIN_ROOT/bin/specwatch-exec" diff "$ARGUMENTS" 2>&1
   ```

3. Present the output:
   - Group changes by endpoint
   - Highlight breaking changes (type changes, removed required fields, removed endpoints) prominently
   - Call out non-breaking additions as safe
   - If no differences found, confirm the API is stable between the two points
   - Suggest actions: if breaking changes exist, flag them as requiring client updates
