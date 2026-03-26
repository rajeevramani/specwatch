# Specwatch

Zero-infrastructure developer tool that learns API schemas from live traffic and generates OpenAPI specs.
Operates as a local reverse proxy: `npx specwatch start https://api.example.com`.

## Status

v0.3.0 implemented and tested. 1037 tests passing across 40 test files.
- Design docs: `build-docs/plans/` (PLAN.md, TASKS.md)
- Backlog: `build-docs/plans/BACKLOG.md` (improvements from real-world testing)
- Tested against MockBank Financial API (72 endpoints, 200 samples). See BACKLOG.md for findings.

## Architecture

Five layers: CLI (commander) -> Proxy (http-proxy) -> Inference Engine -> Storage (SQLite/better-sqlite3) -> OpenAPI Export

## Project Structure

src/cli/        - Commander setup, output formatting, error handling
src/proxy/      - HTTP reverse proxy, body buffering (non-blocking), header capture/redaction
src/inference/  - Schema inference engine (ported from Flowplane Rust)
src/storage/    - SQLite via better-sqlite3, repository pattern, PRAGMA user_version migration system
src/aggregation/- Pipeline: grouping, merging, confidence scoring, breaking change detection
src/export/     - OpenAPI 3.1/3.0 YAML/JSON generation with $ref extraction to components/schemas
tests/          - Integration tests, test server, fixtures

## Tech Stack

- TypeScript (strict), Node.js >= 20, ESM (`type: "module"`)
- Build: tsup (ESM bundle)
- Test: vitest
- Lint: eslint + prettier (singleQuote, trailingComma all, printWidth 100)

## Commands

npm run build    # tsup -> dist/
npm run test     # vitest (806 tests)
npm run lint     # eslint
npm run format   # prettier

## CLI Usage

specwatch start <url> [--port 8080] [--name "my-api"] [--max-samples 100] [--auto-aggregate]
specwatch status
specwatch sessions list
specwatch sessions delete <id>
specwatch aggregate [session-id]
specwatch export [--format openapi|json] [--session <id>] [--snapshot <n>] [--min-confidence 0.5]
specwatch snapshots [session-id]
specwatch diff <session1> <session2> [--snapshots <n1> <n2>]

## Git Style

- Keep commit messages short — one-line summary, no verbose body unless truly needed

## Key Design Decisions

- Raw request/response data is NEVER persisted — only inferred schemas are stored
- Response forwarded to client FIRST, inference runs after (non-blocking proxy)
- SQLite is synchronous (better-sqlite3) with repository abstraction for potential sql.js swap
- Schema inference engine is a TypeScript port of Flowplane's Rust module
- `oneOf` holds full InferredSchema[] (not just type names) — fixes Flowplane's data loss bug
- Format conflicts: same type + different formats → drop format entirely
- `integer -> number` is compatible (widening); `number -> integer` is breaking (fixes Flowplane bug)
- Field is "required" only if present in 100% of samples
- Confidence = (sampleScore * 0.4) + (fieldConsistency * 0.4) + (typeStability * 0.2)
- Path normalization: contextual naming from preceding segment (users/123 → users/{userId})
- Session states: active → aggregating → completed | failed (no idle state)
- Foreground-only proxy (no daemon/PID file); `--auto-aggregate` aggregates every `--max-samples` without stopping; Ctrl+C triggers final aggregation, double Ctrl+C force-quits
- Body limit: 1MB (skip entirely if exceeded, don't truncate)
- Query parameters captured and stored separately; included in OpenAPI export
- Snapshot-based aggregation: cumulative schema building across multiple aggregation runs
- Auto-aggregate mode: `--auto-aggregate` creates snapshots every `--max-samples` and keeps capturing
- Database migrations via `PRAGMA user_version` with automatic apply on open
- OpenAPI export extracts schemas into `components/schemas` with `$ref` references and collision detection