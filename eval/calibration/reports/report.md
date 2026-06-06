# Calibration report — JAIRF signal -> agent task-success

> **Objective.** Which JAIRF signals *causally* move agent task-success, and by how much? One real backend, one fixed agent, one task set; each variant degrades one JAIRF signal *family* (completeness via the backend `THIN_RESPONSES` toggle, the rest via the spec), so a success drop is *attributable* to that family. The deltas below are empirical, causal weights to replace AgentReady’s guessed ones.

Generated: 2026-06-06T03:31:35.339Z
Gold (baseline) variant: `gold`  ·  significance alpha = 0.05

_Reproducible from run artifacts via_ `npm run calib:analyze` _(reads the variant manifest, the agent-runner `<variant>.json` success records, and the specwatch `<variant>.specwatch.json` telemetry; writes this report + `analysis.json`)._

## 1. Signal → success table (the deliverable)

Per ablated signal: gold success vs the degraded variant’s success, the delta (the empirical weight), and whether the move is statistically significant. `Δ success` is the causal effect of degrading **only** that signal.

| JAIRF signal | Variant | JAIRF key drop | Gold success | Degraded success | Δ success | p | Significant? |
|---|---|---|---|---|---|---|---|
| `descriptions` | `no-descriptions` | description_coverage 100→26<br>doc_clarity 100→26<br>descriptive_richness 100→26 | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |
| `operationId` | `bad-operationids` | operationid_quality 100→22<br>tool_calling 100→65<br>distinctiveness 100→64 | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |
| `examples` | `no-examples` | request_examples 35→0<br>response_examples 100→0 | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |
| `errorSchemas` | `no-error-schemas` | error_standardization 100→0 | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |
| `completeness` | `thin-responses` | _(runtime-only; spec = gold)_ | 100% (5/5) | 100% (5/5) | **0pp** | 1.000 | no |

**No signal moved success on this dataset** — and this was a LIVE run (`openrouter:anthropic/claude-sonnet-4.5`): every degraded variant matched gold (full success). A real null result — for this conventional CRUD API and 5-task set, the agent was robust to every ablation. See notes for how to harden the setup to surface a gradient.

## 2. Per-variant summary (static score + runtime telemetry)

| Variant | Degrades | JAIRF | Success | Calls | Verif. loops | Wasted | Avg completeness | Thin endpoints |
|---|---|---|---|---|---|---|---|---|
| `gold` | — | 93 (A) | 100% (5/5) | 18 | 0 | 0 | — | 0 |
| `no-descriptions` | descriptions | 84 (B) | 100% (5/5) | 18 | 0 | 0 | — | 0 |
| `bad-operationids` | operationId | 87 (B) | 100% (5/5) | 18 | 0 | 0 | — | 0 |
| `no-examples` | examples | 84 (B) | 100% (5/5) | 18 | 0 | 0 | — | 0 |
| `no-error-schemas` | errorSchemas | 88 (B) | 100% (5/5) | 18 | 0 | 0 | — | 0 |
| `thin-responses` | completeness _(runtime)_ | 93 (A) | 100% (5/5) | 18 | 0 | 0 | — | 0 |
| `all-bad` | descriptions, operationId, examples, errorSchemas, completeness _(runtime)_ | 63 (C) | 100% (5/5) | 18 | 0 | 0 | — | 0 |

## 3. Prediction quality — static-only JAIRF vs static + specwatch telemetry

Does specwatch runtime telemetry add predictive signal *beyond* the static read? We correlate per-variant success against (a) the static JAIRF overall score, and (b) JAIRF overall adjusted by a runtime struggle penalty (verification loops + wasted requests + response thinness).

| Predictor | Pearson r | R² | n (variants) |
|---|---|---|---|
| Static-only JAIRF | 0.000 | 0.000 | 7 |
| Static + specwatch telemetry | 0.000 | 0.000 | 7 |

**R² gain from telemetry:** 0.000

**Verdict.** No success variance across variants — but this is a LIVE run (openrouter:anthropic/claude-sonnet-4.5): the real agent passed every task on every variant, including the degraded ones. The gradient is flat because the agent was robust to these spec ablations on this task set, not because the data is synthetic. Correlation is undefined (no variance), so prediction can't be evaluated. To surface a gradient, raise difficulty (harder/ambiguous tasks, a weaker agent, an API where descriptions/operationIds are load-bearing) — see notes.

## 4. Notes

- All variants have identical success rates — and this is a LIVE run (openrouter:anthropic/claude-sonnet-4.5). The real agent completed every task on every variant, including bad-operationids, thin-responses, and all-bad. This is a genuine NULL result, not a synthetic artifact: for this conventional CRUD backend and this 5-task set, JAIRF spec quality did not move agent task-success. Likely because the ablations leave the load-bearing structure intact (routes, methods, parameter schemas), and a capable agent infers the API from that alone. To get a non-flat gradient, harden the setup: harder/ambiguous tasks, more tasks (for power), a weaker/cheaper agent, or an API where descriptions/operationIds/examples are actually load-bearing (non-obvious params, info only in prose).

## Provenance

- Manifest: `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/variants/manifest.json`
- Run artifacts: `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/all-bad.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/bad-operationids.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/gold.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/no-descriptions.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/no-error-schemas.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/no-examples.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/thin-responses.json`
- Specwatch captures: `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/all-bad.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/bad-operationids.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/gold.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/no-descriptions.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/no-error-schemas.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/no-examples.specwatch.json`, `/Users/rajeevramani/workspace/projects/specwatch/eval/calibration/.runs/thin-responses.specwatch.json`

