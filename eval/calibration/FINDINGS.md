# Calibration findings — does JAIRF spec quality predict agent success?

Date: 2026-06-06 · Branch: `feat/jairf-readiness-phase1` · Epic: `specwatch-57p`

## TL;DR (the null result)

**For a conventional CRUD API, an OpenAPI spec's prose-quality — the things JAIRF
scores (descriptions, examples, operationId naming, error-response schemas, response
completeness) — had no measurable effect on a frontier agent's task success or effort.**
This held across **two independent frontier models (Claude Sonnet 4.5 and OpenAI
GPT‑5.5)**. A weak model (Qwen3‑8B) failed, but on *orchestration competence*, not spec
quality, and too noisily to read a gradient.

A **30‑point JAIRF swing (gold 93/A → all‑bad 63/C) moved agent success by zero.**

## What we tested

- **Backend** — one purpose-built, conventional REST CRUD API (customers / orders /
  line-items), deterministic seed, ground-truth `/__truth` readback. Fresh per task.
- **Gold spec** — hand-authored OpenAPI 3.1, JAIRF **93 / A / Level 4**.
- **7 variants** — gold + single‑signal‑family ablations + an all‑bad combination:
  | variant | JAIRF | what's degraded |
  |---|---|---|
  | gold | 93 / A | nothing |
  | no-descriptions | 84 / B | all descriptions stripped |
  | no-examples | 84 / B | request/response examples stripped |
  | no-error-schemas | 88 / B | 4xx/5xx schemas removed |
  | bad-operationids | 87 / B | operationIds removed/mangled |
  | thin-responses | 93 | writes return id-only bodies (runtime) |
  | all-bad | 63 / C | all of the above at once |
  > Ablation degrades the spec's **prose/metadata**; it leaves the **structure**
  > (routes, HTTP methods, parameter schemas) intact — which is the part JAIRF barely
  > scores and the part an agent actually needs.
- **Agent** — one fixed persona ("e-commerce shopping assistant") + a fixed set of
  **8 goal-level tasks** (domain intent with *indirect* verbs — "call it off", "dispatch
  it", "erase it" — so the agent must use the spec to map intent → operations). Success
  decided **only** by ground truth, never self-report. Run via OpenRouter (OpenAI-format
  client), `temperature: 0`.

## Results

Success (tasks passed / 8) and total tool calls, per variant:

| variant | JAIRF | Sonnet‑4.5 | GPT‑5.5 | Qwen3‑8B |
|---|---|---|---|---|
| gold | 93 | 8/8 · 24 calls | 8/8 · 25 | 4/8 (noisy) |
| no-descriptions | 84 | 8/8 · 24 | 8/8 · 26 | 5/8 |
| no-examples | 84 | 8/8 · 24 | 8/8 · 25 | 5/8 |
| no-error-schemas | 88 | 8/8 · 24 | 8/8 · 24 | 3/8 |
| bad-operationids | 87 | 8/8 · 24 | 8/8 · 24 | (not captured) |
| thin-responses | 93 | 8/8 · 24 | 8/8 · 30 | (not captured) |
| **all-bad** | **63** | **8/8 · 24** | **8/8 · 24** | (not captured) |

(An earlier sweep with a neutral "automated API client" prompt + 5 spelled-out mechanical
tasks was also flat: Sonnet 5/5 on every variant, 18 calls each.)

**Frontier agents: flat on every axis.** Sonnet's call counts were *byte-identical* (24)
across all variants including all-bad — it runs the same optimal path regardless of spec
quality. GPT‑5.5 the same within noise.

**Weak agent (Qwen3‑8B): noise, not a gradient.** It scored 3–5/8 even on gold, bouncing
with no relation to the JAIRF column (a *worse* spec scored *higher* in one run), and gold
itself drifted 3/8→4/8 on the identical spec. Its failures were dependent-call sequencing
("created the customer, gave up before the order"), i.e. a *competence* ceiling, not a
spec-quality one. One efficiency blip (no-descriptions made it use +77% more calls) was
undercut by that same run passing *more* tasks → noise.

## Why no gradient

A capable agent navigates the API from its **structure** — the routes, methods, and
parameter input-schemas — which the ablations leave intact. The spec's *prose*
(descriptions, examples, friendly names, error bodies) is help a strong model on a
**conventional** API does not need. So degrading the prose changes nothing it relies on.

## What this means for AgentReady / JAIRF

- The JAIRF score measures **spec hygiene** — does the document *declare* the things that
  make an API legible. Real and useful for humans and tooling.
- In this setup it **did not predict agent task-success or effort.** A 30-point swing cost
  zero tasks on two frontier models.
- Plausible reframing: JAIRF's prose signals are **insurance for unconventional APIs or
  weak/old agents** — not a gate for capable agents on conventional, structurally-sound
  APIs. The score grades the *declaration*, not the *runtime sufficiency for an agent*, and
  on a clean conventional API those two come apart.

## Honesty notes

- This is a genuine **null**, not a wiring artifact: runs were live (real OpenRouter
  calls), graded by ground truth, reproducible from `.runs*/` artifacts.
- We hunted for an effect across several conditions (strong → weak agent, success →
  efficiency metric, more tasks). It did not cleanly appear. At one point the write-up
  over-stated a single noisy data point as a signal; corrected here. The disciplined
  reading is: **the effect is small-to-absent in this setup**, not one experiment away.

## Limits / where a gradient might still live (hypotheses, not results)

- **Unconventional / ambiguous APIs** — non-RESTful routes, non-obvious params, required
  semantics that live *only* in descriptions → structure alone would be insufficient and
  prose would become load-bearing. (We tested a deliberately conventional API.)
- **Efficiency under a mid-capability agent, averaged over many runs** — a bad spec may not
  *stop* a weak-but-competent agent but make it work measurably harder; single runs are too
  noisy to tell. Needs ~3–5 runs/variant.
- **Binary task-success is a blunt metric** — it can't see "succeeded but fumbled."

## Provenance

- Models (via OpenRouter): `anthropic/claude-sonnet-4.5`, `openai/gpt-5.5`, `qwen/qwen3-8b`.
- Harness: `eval/calibration/` (backend, gold spec, ablation, runner, capture, analyze).
- Run artifacts: `.runs/` (sonnet), `.runs-gpt55/`, `.runs-qwen8b/` (gitignored).
- Tasks: `specwatch-57p` (epic), `specwatch-w7x` (first live sweep), `specwatch-ewk`
  (persona + goal hardening + this write-up).
