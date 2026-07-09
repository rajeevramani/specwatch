# Calibration Experiment — Matrix

> Does degrading one OpenAPI signal family **causally** lower agent task-success (or raise
> effort)? Constant agent + constant task set; only the spec varies. Success is decided by
> the backend's `/__truth` DB readback — never the agent's self-report.

Sources: `variants/manifest.json` (static JAIRF scores), `reports/analysis.json` (committed
Sonnet-4.5 sweep), `FINDINGS.md` (cross-model results). GPT-5.5 and Qwen3-8B raw artifacts
(`.runs-gpt55/`, `.runs-qwen8b/`) are gitignored — only summarized in `FINDINGS.md`.

## 1. Variant design matrix

| Variant | Signal family degraded | JAIRF keys moved (gold → degraded) | Type | JAIRF | Grade |
|---|---|---|---|---|---|
| `gold` | none (baseline) | — | static | 93 | A |
| `no-descriptions` | descriptions | description_coverage 100→26, doc_clarity 100→26, descriptive_richness 100→26 | static | 84 | B |
| `bad-operationids` | operationId | operationid_quality 100→22, tool_calling 100→65, distinctiveness 100→64 | static | 87 | B |
| `no-examples` | examples | request_examples 35→0, response_examples 100→0 | static | 84 | B |
| `no-error-schemas` | errorSchemas | error_standardization 100→0 | static | 88 | B |
| `thin-responses` | completeness | — (spec == gold; backend `THIN_RESPONSES` toggle) | **runtime** | 93 | A |
| `all-bad` | all 5 at once | every key above | static + runtime | 63 | C |

## 2. Results — success (tasks passed / 8) · total tool calls, per model

| Variant | JAIRF | Sonnet-4.5 | GPT-5.5 | GLM-5.2 | Qwen3-8B |
|---|---|---|---|---|---|
| gold | 93 | 8/8 · 24 | 8/8 · 25 | 8/8 · 25 | 4/8 (noisy) |
| no-descriptions | 84 | 8/8 · 24 | 8/8 · 26 | 8/8 · 28 | 5/8 |
| no-examples | 84 | 8/8 · 24 | 8/8 · 25 | 8/8 · 25 | 5/8 |
| no-error-schemas | 88 | 8/8 · 24 | 8/8 · 24 | 8/8 · 27 | 3/8 |
| bad-operationids | 87 | 8/8 · 24 | 8/8 · 24 | 8/8 · 25 | (not captured) |
| thin-responses | 93 | 8/8 · 24 | 8/8 · 30 | 8/8 · 26 | (not captured) |
| **all-bad** | **63** | **8/8 · 24** | **8/8 · 24** | **8/8 · 24** | (not captured) |

GLM-5.2: live OpenRouter run (`z-ai/glm-5.2`), persona + goal task set, temp 0, this session.
Flat on success across the full 30-point JAIRF swing; call counts wobble 24–28 with no
monotonic relation to JAIRF (all-bad is the *lowest* at 24) — noise, not a gradient.

Earlier sweep (neutral "automated API client" prompt + 5 spelled-out mechanical tasks): also
flat — Sonnet 5/5 on every variant, 18 calls each.

## 3. Causal signal → success (Sonnet-4.5 sweep, from `analysis.json`)

8 tasks/variant, temp 0, two-proportion z-test.

| Signal | Variant | Gold pass | Degraded pass | Success Δ | z | p | Significant? | Verif-loop Δ | Wasted-req Δ |
|---|---|---|---|---|---|---|---|---|---|
| descriptions | no-descriptions | 8/8 | 8/8 | 0 | 0 | 1 | ❌ | 0 | 0 |
| operationId | bad-operationids | 8/8 | 8/8 | 0 | 0 | 1 | ❌ | 0 | 0 |
| examples | no-examples | 8/8 | 8/8 | 0 | 0 | 1 | ❌ | 0 | 0 |
| errorSchemas | no-error-schemas | 8/8 | 8/8 | 0 | 0 | 1 | ❌ | 0 | 0 |
| completeness | thin-responses | 8/8 | 8/8 | 0 | 0 | 1 | ❌ | 0 | 0 |

**Significant signals: none. Directional movers: none.**

## 4. Prediction — does specwatch runtime telemetry beat static scoring?

| Model | n | Pearson r | R² | R² gain |
|---|---|---|---|---|
| static JAIRF only | 7 | 0 | 0 | — |
| static + specwatch runtime | 7 | 0 | 0 | 0 |

Correlation undefined: zero success variance across variants → prediction can't be evaluated.

## 5. Verdict

- **Genuine NULL result, not a synthetic/wiring artifact.** Live OpenRouter calls, graded by
  ground truth, reproducible from `.runs*/`.
- **Frontier agents (Sonnet-4.5, GPT-5.5, GLM-5.2): flat on every axis.** A 30-point JAIRF
  swing (93 → 63, all-bad) cost **zero** tasks on all three. Sonnet's call counts were
  byte-identical (24) across all variants including all-bad; GPT-5.5 and GLM-5.2 the same
  within noise (GLM-5.2: 24–28 calls, lowest on all-bad).
- **Weak agent (Qwen3-8B): noise, not a gradient.** 3–5/8 even on gold, uncorrelated with
  JAIRF; gold itself drifted 3/8→4/8 on identical spec. Failures were dependent-call
  *sequencing* (competence ceiling), not spec quality.
- **Why:** a capable agent navigates the API from its **structure** (routes, methods,
  parameter schemas) — which the ablations leave intact. The ablated **prose**
  (descriptions, examples, friendly names, error bodies) is help a strong model on a
  conventional API does not need.
- **Reframing for JAIRF/AgentReady:** the score measures spec **hygiene** (does the doc
  *declare* legibility) — real and useful — but in this setup it did **not** predict agent
  task-success or effort. Plausibly insurance for unconventional APIs or weak/old agents,
  not a gate for capable agents on conventional, structurally-sound APIs.
- **To surface a gradient:** harder/ambiguous tasks, more tasks (statistical power), a weaker
  agent, or an API where descriptions/operationIds/examples are actually load-bearing
  (non-obvious params, info only in prose).

## Model / config provenance

- Models (via OpenRouter): `anthropic/claude-sonnet-4.5`, `openai/gpt-5.5`, `z-ai/glm-5.2`,
  `qwen/qwen3-8b`.
- Committed analysis (`reports/analysis.json`): Sonnet-4.5 only.
- Uncommitted (gitignored) raw artifacts: `.runs/` (sonnet), `.runs-gpt55/`, `.runs-qwen8b/`,
  `.runs-glm52/` (glm-5.2, this session).
- Backend: thin Express + SQLite CRUD (customers/orders/line-items). Success via `/__truth`.
