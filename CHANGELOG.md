# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Local candidate `0.4.0` and minimum Node22 are approved for preparation, not publication. Changes remain Unreleased until a separately authorized release. Qualify the exact new source/package checksum rather than relabeling historical `0.3.4` evidence. npm's latest published version remains `0.3.2`.

### Changed / migration

- **Plain capture is the supported interface, including human TTY sessions.** The earlier local dashboard is dormant, not a supported `0.4.0` feature, and has no CLI opt-in. Its aggregate-then-quit snapshot collision remains a recorded defect, not a fixed/passing path. Use explicit aggregation/export commands and `Ctrl+C` for owned-process shutdown.

- **Minimum runtime is Node.js 22.** Node20 support is dropped to align the package, CI and Ink dependency requirements. Earlier successful Node20 execution is not qualification of the new candidate.

- **Header metadata is structural only.** Captured, stored and exported header entries now contain valid lowercase names and optional closed Bearer/Basic classifications for `authorization`; all raw, masked and empty `example` fields and arbitrary extra fields are removed. Unknown auth schemes retain their header name only. Bearer/Basic and X-API-Key discovery remain supported; forwarded header values are unchanged.
- **Header export semantics:** shared application-header names remain per-operation optional string parameters, without examples. With metadata enabled, `x-specwatch-global-headers` means presence across operations, not equal header values. Raw JSON header shape and header-name casing intentionally change.
- **Forward-only database migration v4** logically cleans the four header JSON columns in samples/aggregated schemas, preserving nonheader records and snapshots. Old binaries reject a v4 store. Invalid legacy header JSON aborts/rolls back the v4 step with a fixed value-free error; the failed-open handle closes. For recovery, use a different empty `SPECWATCH_HOME` and private maintainer assistance, not printed raw JSON, forced schema versions or the old capture binary.
- **Logical cleanup is not secure erasure:** historic values may survive WAL/free pages, snapshots, backups and existing exports, which are not automatically erased. The strict header guarantee applies to new retained/exported metadata, not all path/query/schema values or caller-owned historical files.

### Fixed

- Successful static sibling routes no longer collapse into invented parameterized endpoints solely because their response shapes match. Uncertain alphabetic IDs remain literal; recognized capture normalization is unchanged, and conservative legacy/manual ID grouping remains supported.
- Nullable promoted-model references retain their null alternative in OpenAPI 3.1 and 3.0, without making shared non-null models nullable. The 3.0 representation uses an explicit null-only union branch rather than a misleading `nullable` sibling on a reference.

- Response-header capture observes explicit object/status-message/raw-array `writeHead` arguments as well as implicit `setHeader` paths, without changing native forwarding, override/duplicate behavior or original protocol errors. Projection failure cannot prevent the original response.
- Seven TypeScript errors corrected; `typecheck` is now mandatory in CI, and tests build the CLI first so subprocess tests run current code.

### Changed (breaking agent CLI)

- **`specwatch agent-report` now emits machine-readable AgentEvidence JSON on stdout by default** for `--consumer agent` sessions (schema `specwatch.agent_evidence.v1`). It previously printed human-readable tables to stdout. Use `--human` (or `--format human`, or `--pretty`) to restore the tables. `-o <file>` is unchanged (still writes the evidence JSON to a file); with `-o` and no `--human`, stdout also stays JSON. Any script that parsed the old table output from stdout must switch to `--human` or consume the JSON. No deprecation window — the agent surface is young (introduced in the 0.3.x line) and carried no stable-contract promise.

### Added

- A candidate-only standalone `skills/learn-api/SKILL.md`, distributed separately from the npm CLI, and a repeatable source-package rehearsal at `scripts/qualify-candidate.mjs`. Neither is a marketplace listing or tagged-release qualification.
- **`specwatch investigate --json`.** Emit the redundant-call investigation as a pinned snake_case contract (schema `specwatch.investigation.v1`). Without `--json`, human output is unchanged.
- **`specwatch agent-report --format json|human`**, plus `--human` and `--pretty` aliases.

## [0.3.2] - 2026-03-29

Published to npm and recorded in the GitHub v0.3.2 release on this UTC date. The release includes the v0.3.x development history below; repository tags `v0.3.0` and `v0.3.1` identify milestones, but the npm version history does not show separate publications of those versions. No npm `0.3.3` or `0.3.4` release is implied.

### Added (v0.3.x)

- Agent-consumer sessions and REST/MCP/JSON-RPC analysis: agent reports, redundant-call investigations, session phases and optional LLM explanations.
- Shared domain-model discovery, wired into CLI OpenAPI export, to reuse named schemas across endpoints. This does not assert that every nested-model/nullability boundary is correct.

### Fixed

- Investigation recommendations use per-pair causes instead of repeating only the primary cause.

History sources: [GitHub release v0.3.2](https://github.com/rajeevramani/specwatch/releases/tag/v0.3.2), repository milestones `102012f` (agent/MCP support), `39ba1c8` (CLI domain-model wiring), `0e3c449` (per-pair recommendation fix), and the npm publication record.

## [0.2.0] - 2026-03-15

### Changed

- **No longer need to stop the proxy to get a spec.** In v0.1.0, you had to `Ctrl+C` the proxy before it would aggregate and produce a schema. With `--auto-aggregate`, specwatch now aggregates in the background every `--max-samples` requests while the proxy keeps running. You can export a spec at any time without interrupting traffic capture.

### Added

- Snapshot-based aggregation: cumulative schema building across multiple aggregation runs within a session
- Auto-aggregate mode (`--auto-aggregate`): automatically aggregates every `--max-samples` and keeps capturing
- `specwatch snapshots` command to list snapshots for a session
- Snapshot diffing: `specwatch diff --name "api" --snapshots 1 3` to compare snapshots within a session
- `--snapshot <n>` option on `specwatch export` to export a specific snapshot
- Database migration system using `PRAGMA user_version` with automatic migration on database open
- Pre-migration database detection and safe upgrade path
- Schema extraction into `components/schemas` with `$ref` references in OpenAPI export
- Auto-generated PascalCase schema names from HTTP method + path (e.g., `GetUsersUserIdResponse`)
- Schema collision detection: identical schemas deduplicated, different schemas get numeric suffix
- Integration tests for auto-aggregate threshold triggering and diff --snapshots parsing

### Fixed

- Race condition: proxy now drains in-flight connections before running auto-aggregation
- `convertDeep` OAS 3.0 conversion scoped to `components.schemas` only (no longer matches bare `schemas` keys elsewhere in the document)

## [0.1.0] - 2026-03-10

### Added

- Local reverse proxy for capturing API traffic (`specwatch start <url>`)
- Automatic schema inference from JSON request/response bodies
- OpenAPI 3.1 and 3.0.3 export (`specwatch export`)
- Type inference: string, integer, number, boolean, array, object
- Format detection: email, date, date-time, uri, uuid, int32, int64, double
- Required field detection (fields present in 100% of samples)
- Enum detection for low-cardinality string fields
- Query parameter capture and type inference
- Path parameter inference with contextual naming (`/users/123` → `/users/{userId}`)
- Path parameter type inference (integer when all values numeric)
- Security scheme detection (Bearer, Basic, API Key)
- Multiple response status code support
- Session management with named sessions (`--name`)
- Breaking change detection between sessions (`specwatch diff`)
- Confidence scoring per endpoint
- Non-blocking proxy design (zero latency impact)
- Privacy-first: raw request/response data never stored
- PATCH request bodies exempt from required field marking
- Body size limit (1MB) to prevent memory issues
