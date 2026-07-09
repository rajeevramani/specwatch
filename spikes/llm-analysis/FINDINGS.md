# Spike findings: local LLM for agent-analysis enrichment (specwatch-6dv)

2026-06-10 · M4 Pro 48GB · Ollama runtime · `spike.mjs`

## Question

Can a small local LLM beat specwatch's heuristics where they are known weak?
Two tasks, real weak spots from `src/analysis/`:

- **Task A — semantic tool matching** (18 cases): replaces verb-prefix + plural-strip
  suffix match from `completeness.ts`. Cases include heuristic-solvable, suffix
  mismatches (`create_cluster → describe_cluster_config`), irregular plurals,
  verbs outside `READ_VERBS`, negatives, and traps (`create_cluster_backup → list_backups`).
- **Task B — verification-loop false-positive judging** (8 cases): replaces the
  "write→read same resource ≤2000ms" rule from `sequences.ts`. Cases include scenario
  boundaries, input-gathering reads, error recovery, 202 polling, filtered audit reads.

## Results

| Model | A: tool match (18) | B: verify-loop FP (8) | Latency A / B |
|---|---|---|---|
| heuristic baseline | 33% | 38% | ~0 |
| LFM2.5-1.2B-Instruct Q4 | **6%** | 38% (answers "true" always) | 155ms / 399ms |
| qwen3:1.7b | 50% | 38% | 258ms / 692ms |
| lfm2.5 (8B-A1B, reasoning) | **94%** | 38% | 4.7s / 11.3s |
| gemma4:e4b | **89%** | **75%** | 875ms / 1.2s |

## Conclusions

1. **Semantic tool matching is a clear LLM win — but only at 4B+ active params.**
   33% → 89–94%. Runs once per aggregation over a handful of write tools, so even
   1s/call is fine.
2. **1.2B-class models fail outright.** LFM2.5-1.2B echoed the *write* tool back as
   the match (comprehension failure, not formatting). Qwen3-1.7B over-abstains
   (answers null on anything non-obvious). The "tiny model on-device" pitch does not
   hold for these tasks.
3. **Verification-loop FP judging is genuinely hard.** Only gemma4:e4b beat baseline
   (6/8 vs 3/8 — weak evidence at n=8). Small models parrot the heuristic. Needs
   richer input (request params, response field diffs) and a larger labeled set
   before shipping.
4. **Liquid AI specifically: not the winner.** LFM2.5-1.2B too weak; LFM2.5-8B-A1B has
   the best Task A score but is a reasoning model (`think: false` not honored via
   Ollama → 5–11s/call) and carries the LFM Open License $10M-revenue cap, which
   binds specwatch *users*. gemma4:e4b gives 89%/75% at ~1s with no license cap.
5. **Integration path: no bundling needed.** Existing `src/llm/client.ts` already
   speaks OpenAI-compatible chat; Ollama serves that at `localhost:11434/v1`. An
   opt-in `--llm-match` enrichment pass (pluggable model, default gemma-class) fits
   the zero-infrastructure principle better than embedding 5GB of weights via
   node-llama-cpp.

## Caveats

- Hand-crafted ground truth; a few Task B labels debatable ("verify after update"
  read could plausibly feed the following DELETE).
- One prompt iteration on Task B (first-round definition was too loose; all models
  over-predicted "not a loop"). Numbers are sensitive to prompt wording.
- Ollama's `format` JSON-schema constraint was not applied to the HF-pulled GGUF
  (markdown fences in output) — production use needs grammar enforcement verified
  per model, or node-llama-cpp's GBNF grammars.

## Recommended next step (if pursued)

Slice 1: opt-in LLM pass for JSON-RPC tool matching only — extend `LlmConfig` with
Ollama default endpoint, add `findMatchingReadToolLlm()` behind a flag, fall back to
heuristic on any failure. Defer verification-loop FP filtering until a labeled
eval set exists (build from calibration harness scenarios).
