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

---

## Blog idea — "Agents read the skeleton, not the prose"

**Status: idea / draft-pending.** Logged 2026-06-07.

### Hook
We took a clean OpenAPI spec, ran it through an AI-readiness scorer (JAIRF: 93/A), then
**wrecked its documentation** — stripped descriptions, examples, error schemas, mangled
operationIds — dropping the score to **63/C**. A 30-point swing. Then we pointed two
frontier agents (Claude Sonnet 4.5, OpenAI GPT-5.5) at it and asked them to do real work.
**They didn't notice.** 8/8 tasks, identical effort, on the gold spec and the wrecked one
alike.

### The precise claim (not the over-claim)
NOT "spec quality doesn't matter." The honest, sharper claim:
> **Given good structure, prose quality doesn't matter. A capable agent navigates from the
> skeleton — routes, HTTP methods, parameter schemas — not from the prose around it.**

Spec quality splits in two: **structure** (load-bearing) and **prose** (decoration for a
strong model on a conventional API). We ablated the prose; the structure we fed clean as
function-calling tool schemas, and never named an operation/route/verb in the prompts —
so the agent had *only* the skeleton to go on, and that was enough.

### The arc (what makes it a complete post, not a hot-take)
1. Wreck the prose → nothing happens (this write-up's data).
2. **Wreck the structure** → predict it breaks (the untested converse — ambiguous params,
   hidden required fields, non-obvious routes, merged tools). *Run this before publishing.*
3. Conclusion: optimize the **skeleton** (clear routes, precise param types/schemas, real
   working auth); stop sweating prose polish — it's insurance for weak agents / weird APIs.

### Why it's worth writing
- Counterintuitive, data-backed, challenges the "score your spec for AI-readiness" pitch.
- Clear mechanism (structure vs prose) → readers learn *why*.
- The **intellectual-honesty thread** is a feature: we hunted for the effect across
  conditions (strong→weak agent, success→efficiency, more tasks), nearly dressed up a
  single noisy data point as signal, caught it. "How we tried to fool ourselves and didn't."

### Caveats to state loudly (or a skeptic will)
- N=1 conventional CRUD backend; mostly single runs; binary success is blunt.
- Prose-not-structure — must be hammered or readers mis-read it as "specs are useless."
- Weak-agent (Qwen3-8B) data was noisy + incomplete.

### Suggested spine
Hook (93→63, nothing changed) → setup (ablate prose, hold structure, fixed agent,
ground-truth tasks) → result (flat across Claude + GPT-5.5; weak model just noisy) →
mechanism (agents read param schemas + routes) → the honest twist (where we almost forced a
signal) → so-what (optimize structure, not prose).

### To do before publishing
- [ ] Run the **structure-ablation** experiment (the converse) — gives the second half.
- [ ] Consider ~3–5 runs/variant + one messier/unconventional API to kill the "too easy" critique.
- [ ] Open-source the harness + link it (reproducibility).

## Agent Evidence Bridge — thin vs rich write-response readiness (specwatch-ag5.5)

Date: 2026-06-09. Validates AC #5 of the v0.3.4 agent-evidence-bridge: thin write
responses produce weaker runtime readiness than rich ones, scored through the real
embedded `x-specwatch-agent` consumption path in `@agentready/scoring` (the same
path pinned by the ag5.4 contract test).

Method (deterministic, not a live sweep): overlay representative per-operation
runtime evidence on every write op of the gold spec, then score.
- THIN: `responseCompleteness 0.2`, `verificationLoopDetected true`, `verificationLoopCount 3`.
- RICH: `responseCompleteness 1.0`, `verificationLoopDetected false`.

| Run | JAIRF overall |
| --- | --- |
| baseline (no runtime evidence) | 93 |
| + RICH write-response evidence | 93 |
| + THIN write-response evidence | 87 |

Result: rich (93) > thin (87); thin drags the evidence-free baseline down by 6
points; rich runtime evidence confirms the already-strong gold spec (no drag).
Both runtime runs report `runtimeVerified: true` (the extension is consumed).
Guarded by `backend/test/runtime-thin-vs-rich.test.ts`.
