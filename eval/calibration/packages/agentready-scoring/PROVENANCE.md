# Provenance — `@agentready/scoring`

## Source of truth

```
agent-ready-score/src/lib/scoring.ts   (sibling repo)
```

This package's `src/vendor/scoring.ts` is a **verbatim vendored copy** of that
file, with a "DO NOT EDIT" banner prepended. Everything public is re-exported
from `src/index.ts`:

- `scoreSpec(spec, opts?)` → `ScoreResult` (numeric `overall` JAIRF score + the
  six weighted dimension categories, each with its per-signal breakdown).
- `extractRuntimeSignals(ops)` → `RuntimeSignals`.
- `parseSpec`, the six per-dimension scorers (`scoreFC`, `scoreDXJ`,
  `scoreARAX`, `scoreAU`, `scoreSEC`, `scoreAID`).
- All public types (`ScoreResult`, `CategoryResult`, `SignalResult`,
  `RuntimeSignals`, `SpecwatchAgentExt`, `DimensionInput`, `DimensionResult`,
  etc.).

The vendored file depends only on `js-yaml` — no other AgentReady code is
needed, so the copy is fully self-contained.

## Why vendored instead of a cross-repo workspace import

`agent-ready-score` and `specwatch` are two **separate git repositories** in
sibling directories. There is no published `@agentready/scoring` npm package
(confirmed by the spike). A single npm/pnpm workspace cannot span two repos in
one shot without restructuring both, so we vendor the source and keep an
explicit sync mechanism.

`scoring.ts` remains the **single editable source of truth**. AgentReady's app
keeps importing its own `src/lib/scoring.ts`. The calibration harness and
specwatch import this package. To keep them from diverging:

## Keeping them in sync

```sh
# from the specwatch repo root:
node eval/calibration/scripts/sync-scoring.mjs
# or:
npm --prefix eval/calibration/packages/agentready-scoring run sync
```

The script:

1. Locates the source of truth (env `AGENTREADY_SCORING_SRC`, else the default
   sibling path `../agent-ready-score/src/lib/scoring.ts`).
2. Copies it verbatim into `src/vendor/scoring.ts`, prepending the DO-NOT-EDIT
   banner.
3. Prints the source vs. vendored content hash so drift is visible.

The package vitest (`test/scoring.test.ts`) scores a sample OpenAPI doc and
asserts a numeric JAIRF score + per-signal breakdown — a tripwire that fails
loudly if a future sync breaks the public contract.

## Divergence risk (tracked)

This is a **copy**, so divergence is possible if someone edits
`agent-ready-score/src/lib/scoring.ts` and forgets to re-run the sync script.
Mitigations in place: the DO-NOT-EDIT banner, the sync script, and the contract
test. A stronger guarantee (CI check comparing hashes across both repos, or
publishing `@agentready/scoring` to a registry that both repos consume) is left
as follow-up — see the bead `openIssues`.
