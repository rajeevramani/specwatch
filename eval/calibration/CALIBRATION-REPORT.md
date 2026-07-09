# Does OpenAPI Spec Quality Move Agent Task-Success? A Calibration Study

**Status:** Null result (setup-bounded). **Version:** 1.0 · **Backend:** conventional CRUD REST API.
**Models tested:** Claude Sonnet-4.5, OpenAI GPT-5.5, GLM-5.2, Qwen3-8B (all live via OpenRouter).

> **Reading guide.** §1 is for any reader (the takeaway). §2–§3 state what we tested and the
> assumptions it rests on. §4–§6 are the methodology and data for technical reviewers. §7–§8
> are the honest limits — read these before quoting the result. §9 is implications for
> JAIRF / AgentReady. Appendices hold reproduction detail.

---

## 1. Executive summary

We asked a narrow, causal question: **if you degrade the quality of an API's OpenAPI
specification, does an AI agent get worse at using that API?**

We built a controlled experiment. One fixed agent, one fixed set of tasks, one backend. The
*only* thing we changed between runs was the spec the agent reads — degrading one quality
signal at a time (missing descriptions, mangled operation names, no examples, no error
schemas, thin responses), and finally all of them at once. Task success was graded by reading
the database directly, never by trusting the agent's own report.

**Finding: within this setup, we did not observe any effect of spec quality on task success.**
Three capable models (Sonnet-4.5, GPT-5.5, GLM-5.2) each completed **8/8 tasks on every
variant** — including the "all-bad" spec whose quality score is 30 points lower than the
pristine one. Effort (number of API calls) barely moved and showed no consistent relationship to
spec quality. A deliberately weak model (Qwen3-8B) failed some tasks, but its failures were
random with respect to spec quality — a competence ceiling, not a spec-quality signal.

With 8 tasks per arm, a single run per arm, and a perfect 8/8 ceiling everywhere, this study is
underpowered: it supports *"we did not observe an effect here"* and **not** the stronger *"spec
quality has no effect."* It also degraded only spec **prose**, while the tool builder kept each
tool's HTTP route in its description regardless (see §7, T2) — so even the degraded agents
retained strong structural scaffolding. Read §7 and §8 before quoting any number.

**What this does and does not mean.** It does **not** mean spec quality is worthless. It means
that on a *conventional, structurally-sound* API with *capable* agents and *unambiguous* tasks,
the spec's human-facing prose (descriptions, examples, friendly names) is help those agents did
not need — they navigate the API from its structure (routes, methods, parameter schemas), which
our ablations left intact. The result is **bounded by the setup** (§7), and the setup was
deliberately easy. The honest reading is: *the effect is small-to-absent here*, not *proven
absent everywhere*.

---

## 2. What the framework tests for

The calibration harness is built to answer three linked questions:

1. **Causal weight (primary).** For each OpenAPI quality signal *S*, how much does degrading
   *only S* change agent task-success, relative to a pristine ("gold") spec? Because gold and
   the degraded variant differ in exactly one signal *family*, a success difference is
   attributable to that family **within this harness** — a within-experiment causal estimate.
   Caveats that stop it being a general causal claim: attribution is family-level not per-key
   (§7, T9), there are no repeated trials (T5), and the ablations are not fully clean because the
   tool builder re-injects each route into the description (T2). So read "causal" as *"caused,
   inside this setup"*, not *"the causal weight of this signal in general."*

2. **Effort cost (secondary).** Does degrading a signal make the agent work harder — more tool
   calls, more retries, more redundant verification loops — even when it still succeeds?

3. **Predictive value of runtime evidence (tertiary).** Does *observed agent behaviour*
   (specwatch's runtime telemetry) predict task-success better than the *static* spec-quality
   score alone? This is the specwatch value hypothesis: static hygiene scores grade the
   document; runtime evidence grades what actually happens.

The quality signals come from **JAIRF** (the scoring dimensions AgentReady computes). The study
is, in effect, a **predictive-validity test of JAIRF**: does a higher JAIRF score predict a more
usable-by-agents API?

---

## 3. Assumptions (the load-bearing ones)

Every one of these is a design choice that constrains what the result can claim. They are
listed here, up front, because the null finding is only interpretable against them.

| # | Assumption | Why it matters |
|---|---|---|
| A1 | **The agent is held constant; only the spec varies.** | Isolates the spec as the sole cause. But it also means the result is *per-agent* — a different agent could respond differently. |
| A2 | **Success is decided by ground truth**, read from the backend DB (`/__truth`), never the agent's self-report. | Removes self-report bias — a hard, honest success signal. |
| A3 | **The API is conventional and structurally sound**: RESTful routes, standard methods, typed parameter schemas — all *preserved* in every variant. | The ablations degrade *prose*, not *structure*. A capable agent can infer a clean API from structure alone, so this bounds the effect toward zero. |
| A4 | **Tasks are unambiguous and CRUD-shaped** (create/look-up/update/delete against orders, customers, line-items). | No task requires information that lives *only* in prose. If descriptions were load-bearing, tasks would need to depend on them. |
| A5 | **Ablations degrade one signal *family* at a time** (a family = several coupled JAIRF keys that move together). | Per-key isolation isn't achievable; family-level is the finest clean attribution. |
| A6 | **A single degraded signal produces a modest score drop** (gold 93 → single-signal 84–88); only all-bad is large (63). | The independent variable's range is small for single-signal variants — limits detectable effect. |
| A7 | **Decoding is deterministic-ish** (temperature 0) so reruns are reproducible modulo model nondeterminism. | Reduces noise; does not eliminate provider-side nondeterminism. |
| A8 | **"Capable agent" = current frontier model.** | The null is a frontier-model result; the weak-model arm (Qwen3-8B) is included precisely to probe A3/A8. |

---

## 4. Methodology

### 4.0 How the test was run — a plain walkthrough

Before the formal design, here is the whole thing in order, as it actually executes. If you read
only one part of the methodology, read this.

**The pieces on the table:**

- A **backend** — a small real web server (Express + SQLite) implementing a shop: customers,
  orders, line-items. It starts empty-but-seeded with a few fixed rows.
- A **gold spec** — a hand-written, high-quality OpenAPI document that *describes* that backend.
- A **set of degraded specs** — copies of gold, each with one quality signal deliberately
  wrecked (descriptions stripped, names mangled, examples removed, …), plus one with all of them.
- An **agent** — a single LLM given tools and a task, told to act autonomously.
- A **task set** — eight plain-language jobs like "onboard this customer and cancel their order."
- A **ground-truth checker** — reads the database directly to decide if the job was actually done.

**What happens for ONE variant (say `no-descriptions`), step by step:**

1. **Load the spec.** The harness reads that variant's OpenAPI file.
2. **Turn the spec into tools.** Every operation in the spec becomes one function-calling
   *tool* the agent can call (name, description, parameters — all taken from the spec). This is
   the key mechanism: **the agent only ever knows the API through the spec.** A worse spec means
   worse tool descriptions. Nothing else about the agent changes.
3. **For each of the 8 tasks, in isolation:**
   a. **Start a fresh backend.** New in-memory SQLite, same deterministic seed, on a throwaway
      port. (Fresh per task so one task's writes can't affect another's.)
   b. **Hand the agent the task prompt** plus the tools from step 2.
   c. **Let the agent loop.** It thinks, calls one or more tools; each tool call is turned into a
      real HTTP request to the backend; the real HTTP response is fed back to the agent; it
      decides the next call. Repeat until the agent says it's finished (or a safety cap of 25
      steps is hit). Every call — method, path, status, body, timestamp — is recorded.
   d. **Grade by ground truth.** The harness calls a hidden `/__truth` endpoint that dumps the raw
      database, and runs that task's assertion (e.g. "does an order exist, paid, with these two
      line-items?"). **Pass/fail comes only from the database — the agent's own "done" claim is
      ignored.**
   e. **Tear down** the backend and move to the next task.
4. **Tally** passes/fails and total tool calls for the variant, and write them to disk.
5. **Replay for telemetry.** The recorded traffic is fed through specwatch's own analysis library
   (as if a proxy had watched it), producing runtime signals (calls per task, verification loops,
   response completeness).

Then the whole of steps 1–5 is repeated for **every variant** and **every model**. Because the
agent, tasks, seed, and grading are identical across variants, the *only* thing that differs
between two runs is the spec — so any difference in success is caused by the spec.

**A concrete example.** Task `t2_place_order_and_pay`: the agent is told, in plain language, to
place and pay for an order containing two specific line-items for a customer. With no
pre-knowledge of the API, it reads the tool list, works out it must create/look up the customer,
create an order, add the two line-items, then mark it paid — five dependent calls, each using an
id returned by a previous one. The checker then reads the DB and confirms a paid order with
exactly those two line-items exists. On the gold spec GLM-5.2 did this in 5 calls; on
`no-descriptions` it still did it — the missing prose didn't stop it working out the sequence.

**What is deliberately controlled vs. varied:**

| Held identical across all runs | Varied |
|---|---|
| The agent (model, system prompt, scaffold, temp 0) | The OpenAPI spec the agent reads |
| The 8 tasks and their success assertions | (for the runtime variant) the backend's response fullness |
| The backend code and its seed data | The model, across the 4-model comparison |
| The grading method (`/__truth` DB readback) | |

### 4.1 Design

A **single-factor ablation** design. One hand-authored "gold" OpenAPI 3.1 spec is the baseline.
From it we generate variants, each degrading exactly one JAIRF signal family, plus an all-bad
variant combining all of them. The agent, tasks, and backend are identical across variants.

```
gold spec ──ablate──▶ variant specs ──derive tools──▶ fixed agent runs task set
                                                             │
                                        graded by /__truth ground-truth readback
                                                             │
                          agent traffic ──replay──▶ specwatch analysis (runtime telemetry)
                                                             │
                                                    join ──▶ signal→success + prediction
```

### 4.2 The variants

| Variant | Signal family degraded | JAIRF keys moved (gold → degraded) | Kind | JAIRF | Grade |
|---|---|---|---|---|---|
| `gold` | none (baseline) | — | static | 93 | A |
| `no-descriptions` | descriptions | description_coverage 100→26, doc_clarity 100→26, descriptive_richness 100→26 | static | 84 | B |
| `bad-operationids` | operationId | operationid_quality 100→22, tool_calling 100→65, distinctiveness 100→64 | static | 87 | B |
| `no-examples` | examples | request_examples 35→0, response_examples 100→0 | static | 84 | B |
| `no-error-schemas` | errorSchemas | error_standardization 100→0 | static | 88 | B |
| `thin-responses` | completeness | — (spec identical to gold; backend `THIN_RESPONSES` toggle) | **runtime** | 93 | A |
| `all-bad` | all five | every key above | static + runtime | 63 | C |

Each variant is validated to be legal OpenAPI 3.1 and to differ from gold in exactly one signal
family (asserted by a companion test).

### 4.3 The agent

A raw tool-calling loop — **no agent framework**. The spec is compiled into function-calling
tools; the agent is given a system prompt (a realistic e-commerce "shopping assistant" persona)
and a plain-language task, and calls tools until done. It is a **constant** across all variants:
same model, same prompt, same scaffold. Only the spec — and therefore the tool descriptions the
agent sees — changes.

State isolation: a fresh in-process backend (own SQLite, deterministic seed, ephemeral port) is
started **per task**, so tasks never see each other's writes.

### 4.4 The task set

Eight goal-style tasks over a customers / orders / line-items domain, e.g. *onboard a customer
and cancel their order*, *place and pay for an order with two line-items*, *fulfil a pending
order*, *correct a line-item quantity*, *erase a mistaken order*. Each task carries an
`assert(truth)` function that inspects the final DB state. Most tasks require several dependent
calls (create → use returned id → act), so they exercise real multi-step orchestration.

### 4.5 Grading

Success is a **pure function of ground truth**. After the agent stops, the harness reads
`/__truth` (raw DB state, invisible to the agent) and runs the task's assertion. The agent's own
"I'm done" claim is never trusted.

### 4.6 Models

All live via OpenRouter, temperature 0:

- `anthropic/claude-sonnet-4.5` — frontier (committed machine analysis)
- `openai/gpt-5.5` — frontier
- `z-ai/glm-5.2` — frontier
- `qwen/qwen3-8b` — deliberately weak, to probe whether *any* agent shows a gradient

---

## 5. Results

### 5.1 Task success and effort (tasks passed / 8 · total tool calls)

| Variant | JAIRF | Sonnet-4.5 | GPT-5.5 | GLM-5.2 | Qwen3-8B |
|---|---|---|---|---|---|
| gold | 93 | 8/8 · 24 | 8/8 · 25 | 8/8 · 25 | 4/8 (noisy) |
| no-descriptions | 84 | 8/8 · 24 | 8/8 · 26 | 8/8 · 28 | 5/8 |
| no-examples | 84 | 8/8 · 24 | 8/8 · 25 | 8/8 · 25 | 5/8 |
| no-error-schemas | 88 | 8/8 · 24 | 8/8 · 24 | 8/8 · 27 | 3/8 |
| bad-operationids | 87 | 8/8 · 24 | 8/8 · 24 | 8/8 · 25 | (not captured) |
| thin-responses | 93 | 8/8 · 24 | 8/8 · 30 | 8/8 · 26 | (not captured) |
| **all-bad** | **63** | **8/8 · 24** | **8/8 · 24** | **8/8 · 24** | (not captured) |

### 5.2 Causal signal → success (Sonnet-4.5, committed analysis)

8 tasks/arm; two-proportion z-test, gold vs degraded.

| Signal | Variant | Gold pass | Degraded pass | Δ success | z | p | Significant? |
|---|---|---|---|---|---|---|---|
| descriptions | no-descriptions | 8/8 | 8/8 | 0 | 0 | 1 | No |
| operationId | bad-operationids | 8/8 | 8/8 | 0 | 0 | 1 | No |
| examples | no-examples | 8/8 | 8/8 | 0 | 0 | 1 | No |
| errorSchemas | no-error-schemas | 8/8 | 8/8 | 0 | 0 | 1 | No |
| completeness | thin-responses | 8/8 | 8/8 | 0 | 0 | 1 | No |

**Significant signals: none. Directional movers: none.**

### 5.3 Prediction — does runtime telemetry beat static scoring?

| Predictor | n | Pearson r | R² |
|---|---|---|---|
| static JAIRF only | 7 | not estimable | not estimable |
| static JAIRF + specwatch runtime | 7 | not estimable | not estimable |

Correlation is **not estimable**: with zero variance in the outcome (success is 8/8 on every
variant), the denominator of the correlation is zero, so Pearson *r* and R² are undefined — not
zero. (The committed `analysis.json` stores these as the numeric `0` for want of a null; that is
a serialization placeholder, not a measured value of 0.) The prediction question cannot be
answered from this data — not because runtime evidence failed, but because the outcome never
moved.

---

## 6. Interpretation

- **Frontier agents are flat on every axis.** A 30-point JAIRF swing (gold 93 → all-bad 63) cost
  zero tasks on all three frontier models. Sonnet's call counts were byte-identical (24) across
  every variant; GPT-5.5 and GLM-5.2 varied only within noise (GLM-5.2: 24–28 calls, and its
  *lowest* count was on the *worst* spec — the opposite of a gradient).
- **The weak agent is noise, not a gradient.** Qwen3-8B scored 3–5/8 even on gold, uncorrelated
  with JAIRF (a worse spec scored *higher* in one run), and gold itself drifted 3/8→4/8 on the
  identical spec across reruns. Its failures were dependent-call sequencing ("created the
  customer, gave up before the order") — a competence ceiling, not a spec-quality one.
- **Why the flatness is plausible, not suspicious.** A capable agent navigates an API from its
  *structure* — routes, methods, parameter input-schemas — which the ablations preserve. The
  spec's *prose* is exactly the redundant layer a strong model on a conventional API does not
  lean on. Degrading prose changes nothing it relies on.

---

## 7. Threats to validity (read before quoting)

This section is deliberately the longest. The null is **real for what it measured** and
**setup-bounded** for everything else.

### 7.1 External validity — the setup was easy by construction
- **T1 · Conventional API.** The backend is textbook CRUD with self-describing routes and typed
  params. Real-world APIs where critical information lives *only in prose* (non-obvious enum
  values, side-effects, ordering constraints, auth quirks) are exactly where descriptions become
  load-bearing — and are *untested here*. **This is the single biggest limit.**
- **T2 · Structure-preserving ablations — and the tool builder re-injects it.** We degraded
  prose but never broke routes, methods, or parameter schemas. Worse for clean attribution: the
  tool builder **anchors every tool description with its HTTP route** — `buildDescription()`
  appends `(METHOD /path)` to each tool even when the operation's prose has been stripped
  (`runner/tools.ts:131`), and tool *names* are still derived from the operationId or synthesized
  from method+path (`tools.ts:113`). So the `no-descriptions` agent still sees, on every tool,
  the exact route it hits — e.g. `(POST /orders)`. The "no descriptions" condition therefore
  removes the *prose* but retains strong *semantic scaffolding*, which very likely explains why
  it cost nothing. A stricter ablation would strip the route anchor too (and use opaque paths),
  so descriptions become the only way to know what a tool does. **This is a confound in the
  independent variable, not just an easy-setup caveat**, and it applies to `no-descriptions`,
  `no-examples`, and `bad-operationids`. A quality signal that only bites when *structure* is
  also weak cannot surface in this design.
- **T3 · Capable agents.** Frontier models are robust precisely because they infer well. The
  result may not transfer to smaller/older/cheaper production agents — and the one weak model we
  ran was *too* weak (noise-limited) to resolve a gradient.

### 7.2 Statistical validity — underpowered
- **T4 · Tiny sample.** 8 tasks per arm. With 8/8 vs 8/8 the two-proportion z-test can only
  detect a very large effect; a real 1–2 task degradation would be invisible. Absence of
  significance here is **not** evidence of absence of effect — the study lacks the power to make
  that claim.
- **T5 · No repeated trials per (model, variant).** Single sweep per arm (except Qwen reruns).
  Provider nondeterminism at temp 0 is unquantified. Call-count differences of ±2 are within
  plausible run-to-run noise.
- **T6 · Zero variance breaks the tertiary analysis.** The runtime-vs-static prediction question
  is structurally unanswerable when success never moves; it awaits a setup that produces a
  gradient.

### 7.3 Construct validity — are we measuring the right thing?
- **T7 · Success is binary end-state.** A task either reaches the target DB state or not. It does
  not capture partial progress, latency, token cost, or user-perceived quality — dimensions where
  spec quality might still pay off.
- **T8 · Single-signal range is small.** Individual ablations drop JAIRF only ~5–9 points
  (93→84–88). The independent variable barely moves for single-signal variants; only all-bad is a
  large manipulation, and it too was survived.
- **T9 · Family-level, not key-level, attribution.** Coupled JAIRF keys move together, so we
  attribute to families, not individual keys.

### 7.4 Internal validity — mostly controlled
- **T10 · Mock-agent aliasing (not in these live runs).** The deterministic mock reroutes mangled
  operationIds by route so it still runs; the **live** agent gets no such aliasing, so degradation
  stays visible to it. The results reported here are all live runs, so this does not apply — but
  do not mix mock and live numbers.
- **T11 · Provenance is incomplete in git (auditability gap).** Raw run artifacts for all four
  models exist on disk (`.runs/` sonnet, `.runs-glm52/`, `.runs-gpt55/`, `.runs-qwen8b/`) but are
  **gitignored**, so only Sonnet's machine analysis (`reports/analysis.json`) is committed and
  reviewable from the repo alone. The GPT-5.5 / GLM-5.2 / Qwen numbers in this report are
  transcribed from those local artifacts and are not independently checkable by a reader of the
  committed tree. For external use, commit the per-model run + capture artifacts (or a frozen
  analysis per model). **Fix before publishing.**
- **T12 · specwatch captures were overwritten.** GLM-5.2's capture pass overwrote the local
  Sonnet `.runs/*.specwatch.json` capture artifacts (both gitignored/ephemeral); committed
  reports are untouched. The per-model `.json` run artifacts (success + calls) were written to
  separate dirs and were *not* overwritten.

---

## 8. What we can and cannot conclude

**We can say:**
- On a conventional, structurally-sound API, with capable frontier agents and unambiguous CRUD
  tasks, degrading OpenAPI *prose* quality — even by 30 JAIRF points — did **not** measurably
  reduce agent task-success or effort in this study.
- This held across three independent frontier models, using ground-truth grading, on live runs.

**We cannot say:**
- That spec quality doesn't matter *in general*. The design is biased toward a null (T1–T3) and
  underpowered to detect small effects (T4–T5).
- That JAIRF is not predictive *for the cases it targets* — unconventional APIs, weaker agents,
  prose-dependent tasks — none of which this study exercised.
- Anything about the runtime-vs-static prediction question (T6).

---

## 9. Implications for JAIRF / AgentReady

- JAIRF measures **spec hygiene** — does the document *declare* the things that make an API
  legible. That is real and useful for humans, tooling, and diffing.
- In *this* setup it did **not** predict agent task-success or effort. A 30-point swing cost zero
  tasks on three frontier models.
- A plausible reframing: JAIRF's prose signals are **insurance for the hard cases** —
  unconventional APIs, prose-dependent tasks, and weaker/older agents — not a gate for capable
  agents on conventional, structurally-sound APIs. The score grades the *declaration*; on a clean
  conventional API the declaration and the *runtime sufficiency for an agent* come apart.
- The productive next experiment is to **build the setup where the effect must appear** (§10) —
  and see whether JAIRF (and specwatch runtime evidence) predict it there.

---

## 10. Recommended next experiments (to break the null honestly)

1. **Prose-load-bearing API.** Non-obvious enums, side-effects, and constraints that appear
   *only* in descriptions — so a task cannot succeed without reading them.
2. **Break structure alongside prose, and stop re-injecting the route.** Opaque/opaque-hashed
   paths + mangled operationIds together, and drop the `(METHOD /path)` anchor from tool
   descriptions (`tools.ts:131`) so that in the `no-descriptions` arm the prose is genuinely the
   only source of meaning. Tests whether naming/description signals matter once structure stops
   carrying the agent — directly closes confound T2.
3. **Power up.** 40–100 tasks per arm, ≥3 trials per (model, variant), to detect small effects
   and quantify noise.
4. **Ambiguity + distractors.** Overlapping operations where the right choice depends on
   descriptions.
5. **Mid-tier agents.** A model strong enough to be non-noisy but weak enough to lean on the spec.

---

## 11. Reproducibility & provenance

- **Ablation:** `npm run ablate` → `variants/*.yaml` + `variants/manifest.json` (JAIRF scores).
- **Run (live):** `tsx runner/cli.ts --live --provider openrouter --model <slug> --system assistant --tasks goal --variant <name>`.
- **Grade:** ground truth via backend `/__truth`; success = task `assert(truth)`.
- **Analysis:** `tsx analyze.ts` → `reports/report.md` + `reports/analysis.json` (deterministic).
- **Models (OpenRouter):** `anthropic/claude-sonnet-4.5`, `openai/gpt-5.5`, `z-ai/glm-5.2`,
  `qwen/qwen3-8b`. Temperature 0.
- **Committed machine analysis:** Sonnet-4.5 only (`reports/analysis.json`). GPT-5.5, GLM-5.2,
  Qwen3-8B are summarized in this report and `FINDINGS.md`; their raw run artifacts
  (`.runs-gpt55/`, `.runs-glm52/`, `.runs-qwen8b/`) exist on disk but are **gitignored** →
  see §7 T11. To make this report externally auditable, `git add -f` those dirs (or a frozen
  per-model analysis) and re-run `analyze.ts` per model.
- **Companion docs:** `EXPERIMENT-MATRIX.md` (raw matrices), `FINDINGS.md` (original write-up).

## Appendix A — GLM-5.2 per-task detail (persona + goal, live, temp 0)

Every task PASS on every variant. Per-variant total calls: gold 25, no-descriptions 28,
no-examples 25, no-error-schemas 27, bad-operationids 25, thin-responses 26, all-bad 24. No
monotonic relation between call count and JAIRF; all-bad (lowest JAIRF) had the fewest calls.

## Appendix B — earlier mechanic sweep

A prior sweep with a neutral "automated API client" prompt and 5 spelled-out mechanical tasks
was also flat: Sonnet 5/5 on every variant, 18 calls each — consistent with the persona/goal
result.
