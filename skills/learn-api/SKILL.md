---
name: learn-api
description: Learn observed API schemas with a verified local CLI.
license: MIT
metadata:
  version: 0.1.0
  author: Rajeev Ramani
  status: candidate-only
  command-syntax: POSIX shell
---

# Learn an API from approved traffic

Use a verified Specwatch candidate to capture an owned learning session and export the observed OpenAPI contract. This file is standalone: the public CLI is its only execution dependency. It does not require a plugin, agent-specific tool, helper script or external LLM.

## Availability and prerequisites

This skill is **candidate-only and unlisted**. The published npm `0.3.2` and older packages do not provide the repaired header-metadata contract. The historical local `0.3.4` version label is also insufficient to identify repaired bytes. Do not use an unqualified package, automatic latest-package execution or an unpinned install while promising the new privacy behavior.

Require an explicitly approved repaired candidate identity: source/build identity, exact tarball SHA-256, installed CLI SHA-256, reported version and runtime/platform qualification. Verify the actual local hashes using the host's available checksum facility; do not invent a hash or accept a matching version alone. In a local rehearsal, record those identities against the authorized repaired source and real qualification output. If no trustworthy repaired candidate is available, stop rather than falling back to an old binary. A published minimum version can be documented only after that repaired artifact is released and verified.

Use the tested Node22 runtime for this candidate. Although its manifest currently declares >=20, some runtime dependencies declare >=22; passing tests with engine warnings is not support-policy approval. Native dependencies must be installed/built for the active runtime and architecture. Installation and dependency build scripts require permission; do not silently install software.

## Permission and ownership

Before capture, obtain or confirm all of the following together:

- Target base URL, environment and allowed routes. Default to explicitly approved read-only operations; creating/updating/deleting data or intentionally generating errors needs separate permission.
- Credentials supplied through an approved secret channel or existing protected client configuration—not chat, command history, verbose request logs or generated examples.
- Unused local port, fresh session name, new private store directory and output path. Verify the store is new/empty and do not touch another capture or existing user database.
- Who owns the foreground process and how it will be stopped. An agent may use its own tracked-process facility, retaining the exact process handle/PID; otherwise use a user-owned foreground terminal.
- Permission before overwriting any output. Keep the store and generated artifacts private; inferred query/path/enum values can still be sensitive.

The examples use POSIX environment assignment. Adapt it to the host shell without changing the CLI arguments or ownership rules. Placeholders must be replaced with approved values, not executed literally.

## Procedure

### 1. Bind the verified binary and isolated store

```bash
export SPECWATCH_CLI="/absolute/path/to/approved-consumer/node_modules/.bin/specwatch"
export SPECWATCH_HOME="/absolute/path/to/new-private-store"
"$SPECWATCH_CLI" --version
```

Check the installed CLI checksum and tarball checksum against the candidate record before proceeding. Set `SPECWATCH_HOME` before any command that can open a database; use the same values in every terminal/process in this session. Do not run a preliminary command against the user's default store.

Completion: actual binary/runtime identity matches the approved repaired candidate, and the chosen store/output/port/session are owned and safe to use.

### 2. Start one bounded foreground capture

```bash
"$SPECWATCH_CLI" start "https://approved-api.example" --port 8080 --name "api-learning" --max-samples 200 --consumer agent
```

The URL, port, name and limit are caller-chosen. `--consumer agent` selects non-dashboard output; it does not call an external agent or LLM. Keep this process attached to its foreground terminal, or retain its exact tracked-process handle. Do not detach an untracked process. This sequence deliberately omits auto-aggregation.

Confirm the actual readiness line `Specwatch proxy started` on stderr within a bounded startup window. Abort on early exit, a startup error or timeout; clean up only the process you started. Do not proceed merely because a PID exists. Avoid making an HTTP readiness probe that accidentally becomes unaccounted captured traffic.

Completion: the owned process is listening and ready; its process handle and proxy URL are recorded without credentials.

### 3. Exercise approved traffic through the reverse proxy

Rewrite the request base URL to `http://127.0.0.1:8080`, preserving the intended route/query. Specwatch is a reverse proxy: setting `HTTP_PROXY` does not route these calls through it. Explain this rewrite to the user and exercise only the agreed operations.

Start with a list route and a representative item read if approved; repeat enough valid variations to observe types and optional fields. Do not infer permission for write methods or destructive/error cases from a request to learn the API. Do not print payloads, cookies or authorization headers as a progress mechanism. Report HTTP success/failure and sample counts without raw sensitive data.

Completion: intended fixture/user requests actually crossed the owned proxy. Keep an explicit record of exercised routes/methods and unseen branches; requesting capture alone is not proof of captured samples.

### 4. Stop the owned process and verify aggregation

Send `Ctrl+C` to its foreground terminal, or SIGINT using its exact tracked process handle. Wait for bounded graceful exit and final aggregation. The sample cap may already have stopped it; do not signal a reused PID. Never stop every Node process or an unrelated session.

```bash
"$SPECWATCH_CLI" sessions list
"$SPECWATCH_CLI" snapshots --name "api-learning"
```

Normal shutdown aggregates. If it did not complete, first ensure the owned capture is stopped, inspect the failure and session state, then explicitly run:

```bash
"$SPECWATCH_CLI" aggregate --name "api-learning"
```

Do not blindly rerun aggregation after successful shutdown or treat the separate stop command as proof that the owned OS process terminated. On a shutdown deadline, report the failure and follow the caller's owned-process cleanup authorization rather than declaring success.

Completion: owned capture is no longer running and a real aggregated snapshot exists for the intended session.

### 5. Export and inspect the actual artifact

After confirming that the destination is new or overwrite was approved:

```bash
"$SPECWATCH_CLI" export --name "api-learning" --include-metadata --output "/absolute/path/to/new-openapi.yaml"
```

Read the generated file with the host's available file-reading facility. Check OpenAPI version, observed paths/methods, component references, body types, authentication schemes, per-operation header names, sample counts and confidence extensions. Header parameters must have no value examples; metadata must contain only structural names and closed auth classifications. Do not copy arbitrary header values into the artifact yourself. Resolve component references when summarizing a response shape rather than treating a reference as a missing schema.

Completion: the real export exists, parses, corresponds to the selected session and is inspected—not merely named in a success message.

## Report and limits

Report the exact candidate identity and artifact path, observed operations/sample counts, auth mechanisms and confidence values available in the artifact. Flag low-confidence results and routes, error codes and payload variations not exercised. Do not invent a coverage percentage or call the generated document a complete API contract. Review path normalization, nullability, enums and nested references before generating clients; a successful capture does not prove every inference heuristic is correct.

Header values are not retained by the repaired candidate, but this is not a universal secret scanner. Existing exports/backups/WAL/free pages are not erased by logical v4 migration, and schema/query/path observations can contain sensitive strings. Keep all stores/outputs private and obtain permission before sharing. A migration failure is not permission to print broken JSON, force the version or use the old binary; use a different empty store and seek private maintainer assistance if historical recovery is required.

Leave the generated spec and store at the approved paths. Delete only explicitly authorized owned temporary resources; never remove existing sessions, databases or user files as automatic cleanup. Do not list, sell or publish this skill or candidate as part of learning an API. No claim of verification across other agent hosts or platforms follows from this local walkthrough.
