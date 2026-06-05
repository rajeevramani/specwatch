# Calibration report — JAIRF signal -> agent task-success

> **Objective.** Which JAIRF signals *causally* move agent task-success, and by how much? One real backend, one fixed agent, one task set — only the spec changes. Each variant degrades exactly one JAIRF signal, so a success drop is *attributable* to that signal. The deltas below are empirical, causal weights to replace AgentReady’s guessed ones.

Generated: 2026-06-05T20:55:58.671Z
Gold (baseline) variant: `gold`  ·  significance alpha = 0.05

_Reproducible from run artifacts via_ `npm run calib:analyze` _(reads the variant manifest, the agent-runner `<variant>.json` success records, and the specwatch `<variant>.specwatch.json` telemetry; writes this report + `analysis.json`)._

## 1. Signal → success table (the deliverable)

Per ablated signal: gold success vs the degraded variant’s success, the delta (the empirical weight), and whether the move is statistically significant. `Δ success` is the causal effect of degrading **only** that signal.

| JAIRF signal | Variant | JAIRF key drop | Gold success | Degraded success | Δ success | p | Significant? |
|---|---|---|---|---|---|---|---|
| `descriptions` | `no-descriptions` | description_coverage 100→26<br>doc_clarity 100→26<br>descriptive_richness 100→26 | 100% (5/5) | 80% (4/5) | **-20pp** | 0.292 | no |
| `operationId` | `bad-operationids` | operationid_quality 100→22<br>tool_calling 100→65<br>distinctiveness 100→64 | 100% (5/5) | 60% (3/5) | **-40pp** | 0.114 | no |
| `examples` | `no-examples` | request_examples 35→0<br>response_examples 100→0 | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |
| `errorSchemas` | `no-error-schemas` | error_standardization 100→0 | 100% (5/5) | 60% (3/5) | **-40pp** | 0.114 | no |
| `completeness` | `thin-responses` | _(runtime-only; spec = gold)_ | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |

**No signal reached the p < 0.05 significance threshold** at this per-variant task count (5 tasks/variant is underpowered for the two-proportion z-test). The signals that *directionally* move success, ranked by effect size (most harmful first):

  - `operationId`: **-40pp**
  - `errorSchemas`: **-40pp**
  - `descriptions`: **-20pp**

## 2. Per-variant summary (static score + runtime telemetry)

| Variant | Degrades | JAIRF | Success | Calls | Verif. loops | Wasted | Avg completeness | Thin endpoints |
|---|---|---|---|---|---|---|---|---|
| `gold` | — | 93 (A) | 100% (5/5) | 19 | 0 | 0 | 1.00 | 0 |
| `no-descriptions` | descriptions | 84 (B) | 80% (4/5) | 19 | 2 | 1 | 1.00 | 0 |
| `bad-operationids` | operationId | 87 (B) | 60% (3/5) | 19 | 5 | 4 | 1.00 | 0 |
| `no-examples` | examples | 84 (B) | 100% (5/5) | 19 | 1 | 0 | 1.00 | 0 |
| `no-error-schemas` | errorSchemas | 88 (B) | 60% (3/5) | 19 | 6 | 5 | 1.00 | 0 |
| `thin-responses` | completeness _(runtime)_ | 93 (A) | 100% (5/5) | 19 | 4 | 3 | 0.45 | 3 |
| `all-bad` | descriptions, operationId, examples, errorSchemas, completeness | 63 (C) | 20% (1/5) | 19 | 9 | 8 | 0.40 | 4 |

## 3. Prediction quality — static-only JAIRF vs static + specwatch telemetry

Does specwatch runtime telemetry add predictive signal *beyond* the static read? We correlate per-variant success against (a) the static JAIRF overall score, and (b) JAIRF overall adjusted by a runtime struggle penalty (verification loops + wasted requests + response thinness).

| Predictor | Pearson r | R² | n (variants) |
|---|---|---|---|
| Static-only JAIRF | 0.820 | 0.672 | 7 |
| Static + specwatch telemetry | 0.703 | 0.494 | 7 |

**R² gain from telemetry:** -0.178

**Verdict.** Static JAIRF already captures most of the predictable success variance (R^2 0.672); specwatch telemetry adds -0.178 R^2 — marginal on this dataset.

## Provenance

- Manifest: `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/variants/manifest.json`
- Run artifacts: `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/all-bad.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/bad-operationids.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/gold.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/no-descriptions.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/no-error-schemas.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/no-examples.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/thin-responses.json`
- Specwatch captures: `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/all-bad.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/bad-operationids.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/gold.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/no-descriptions.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/no-error-schemas.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/no-examples.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/fixtures/runs/thin-responses.specwatch.json`

