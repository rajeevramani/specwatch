#!/usr/bin/env node
/**
 * Spike: can a small local LLM (via Ollama) beat specwatch's heuristics on
 * agent-analysis tasks where the heuristics are known to be weak?
 *
 * Task A — semantic tool matching (JSON-RPC completeness):
 *   heuristic = verb-prefix + plural-strip suffix match (replicated from
 *   src/analysis/completeness.ts). LLM gets write tool + candidate read tools.
 *
 * Task B — verification-loop false-positive judging (sequences):
 *   heuristic = write->read same resource within 2000ms => verification loop.
 *   LLM gets surrounding call context and judges intent.
 *
 * Usage: node spike.mjs [model ...]   (default: lfm2.5 qwen3:1.7b gemma4:e4b)
 */

const OLLAMA = 'http://localhost:11434';
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['lfm2.5', 'qwen3:1.7b', 'gemma4:e4b'];

// ---------------------------------------------------------------------------
// Heuristic baseline — replicated from src/analysis/completeness.ts
// ---------------------------------------------------------------------------

const WRITE_VERBS = /(?:^|[-_])(create|set|update|put|patch|add|insert|upsert|delete|remove)[-_]/i;
const READ_VERBS = /(?:^|[-_])(get|query|read|describe|list|fetch|show|find|lookup)[-_]/i;

function getToolResourceSuffix(toolName) {
  const writeMatch = toolName.match(WRITE_VERBS);
  if (writeMatch) {
    const verbEnd = toolName.indexOf(writeMatch[1]) + writeMatch[1].length;
    return toolName.slice(verbEnd).replace(/^[-_]/, '');
  }
  const readMatch = toolName.match(READ_VERBS);
  if (readMatch) {
    const verbEnd = toolName.indexOf(readMatch[1]) + readMatch[1].length;
    return toolName.slice(verbEnd).replace(/^[-_]/, '');
  }
  return toolName;
}

function normalizeResource(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('ses') || lower.endsWith('xes') || lower.endsWith('zes')) return lower.slice(0, -2);
  if (lower.endsWith('ies')) return lower.slice(0, -3) + 'y';
  if (lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

function heuristicMatch(writeTool, readTools) {
  const suffix = getToolResourceSuffix(writeTool);
  const normalized = normalizeResource(suffix);
  const exact = readTools.find((rt) => getToolResourceSuffix(rt) === suffix);
  if (exact) return exact;
  return readTools.find((rt) => normalizeResource(getToolResourceSuffix(rt)) === normalized) ?? null;
}

// ---------------------------------------------------------------------------
// Task A cases — { write, reads, expected } (expected null = no valid match)
// ---------------------------------------------------------------------------

const TASK_A = [
  // -- heuristic-solvable (regression: LLM must not be worse) --
  { write: 'create_cluster', reads: ['list_clusters', 'get_listener', 'list_routes'], expected: 'list_clusters' },
  { write: 'cp_create_filter', reads: ['cp_get_filter', 'cp_list_clusters'], expected: 'cp_get_filter' },
  { write: 'update_policy', reads: ['list_policies', 'get_user'], expected: 'list_policies' },
  { write: 'add_address', reads: ['list_addresses', 'get_zone'], expected: 'list_addresses' },
  // -- heuristic-failing: suffix mismatch / extra words --
  { write: 'create_cluster', reads: ['describe_cluster_config', 'list_nodes'], expected: 'describe_cluster_config' },
  { write: 'add_route', reads: ['show_active_routes', 'get_listener'], expected: 'show_active_routes' },
  { write: 'upsert_dns_record', reads: ['read_zone_records', 'list_zones'], expected: 'read_zone_records' },
  { write: 'update_schedule', reads: ['list_cron_jobs', 'get_schedule_details'], expected: 'get_schedule_details' },
  // -- heuristic-failing: irregular plurals --
  { write: 'create_index', reads: ['describe_indices', 'list_aliases'], expected: 'describe_indices' },
  { write: 'delete_vertex', reads: ['list_vertices', 'get_edge'], expected: 'list_vertices' },
  { write: 'create_person', reads: ['list_people', 'get_org'], expected: 'list_people' },
  // -- heuristic-failing: read verb not in READ_VERBS regex --
  { write: 'set_config', reads: ['dump_settings', 'list_users'], expected: 'dump_settings' },
  { write: 'create_session', reads: ['whoami', 'list_tokens'], expected: 'whoami' },
  // -- semantic: different noun, same domain object --
  { write: 'register_user', reads: ['fetch_account_profile', 'list_groups'], expected: 'fetch_account_profile' },
  // -- negatives: no valid match; heuristic may or may not abstain --
  { write: 'create_cluster', reads: ['list_routes', 'get_listener'], expected: null },
  { write: 'delete_token', reads: ['list_users', 'get_org'], expected: null },
  // -- trap: superficially similar suffix but wrong domain object --
  { write: 'create_cluster_backup', reads: ['list_clusters', 'list_backups'], expected: 'list_backups' },
  { write: 'add_user_to_group', reads: ['list_groups', 'get_group_members'], expected: 'get_group_members' },
];

// ---------------------------------------------------------------------------
// Task B cases — verification-loop judging
// Each case: flagged write->read pair + surrounding call context.
// Heuristic verdict is always "verification loop" (same resource, <=2000ms).
// expected: true = real verification loop, false = false positive.
// ---------------------------------------------------------------------------

const TASK_B = [
  {
    name: 'classic verify after create',
    context: [
      { t: 0, call: 'POST /filters', status: 201 },
      { t: 800, call: 'GET /filters/42', status: 200 },
      { t: 3500, call: 'POST /routes', status: 201 },
    ],
    pair: { write: 'POST /filters', read: 'GET /filters/42', delayMs: 800 },
    expected: true,
  },
  {
    name: 'scenario boundary: new task starts with read of same resource',
    context: [
      { t: 0, call: 'POST /filters', status: 201 },
      { t: 400, call: 'tools/list', status: 200 },
      { t: 900, call: 'GET /filters/42', status: 200 },
      { t: 1400, call: 'PATCH /filters/42', status: 200 },
    ],
    pair: { write: 'POST /filters', read: 'GET /filters/42', delayMs: 900 },
    expected: false, // read is discovery for the upcoming PATCH, not verification — tools/list reset signals new scenario
  },
  {
    name: 'verify after update, slow but intentional',
    context: [
      { t: 0, call: 'PUT /clusters/7', status: 200 },
      { t: 1900, call: 'GET /clusters/7', status: 200 },
      { t: 9000, call: 'DELETE /clusters/7', status: 204 },
    ],
    pair: { write: 'PUT /clusters/7', read: 'GET /clusters/7', delayMs: 1900 },
    expected: true,
  },
  {
    name: 'read is input-gathering for next write, not verification',
    context: [
      { t: 0, call: 'POST /zones', status: 201 },
      { t: 600, call: 'GET /zones/3/records', status: 200 },
      { t: 1200, call: 'POST /zones/3/records', status: 201 },
    ],
    pair: { write: 'POST /zones', read: 'GET /zones/3/records', delayMs: 600 },
    expected: false, // reading child collection to add records — workflow step, not verifying the zone create
  },
  {
    name: 'retry-after-error misflagged as verification',
    context: [
      { t: 0, call: 'POST /orders', status: 500 },
      { t: 1000, call: 'GET /orders', status: 200 },
      { t: 1600, call: 'POST /orders', status: 201 },
    ],
    pair: { write: 'POST /orders', read: 'GET /orders', delayMs: 1000 },
    expected: false, // checking whether the failed POST partially succeeded — error recovery, fixing write response won't remove it
  },
  {
    name: 'verify loop repeated (polling until ready)',
    context: [
      { t: 0, call: 'POST /deployments', status: 202 },
      { t: 1000, call: 'GET /deployments/9', status: 200 },
      { t: 2000, call: 'GET /deployments/9', status: 200 },
      { t: 3000, call: 'GET /deployments/9', status: 200 },
    ],
    pair: { write: 'POST /deployments', read: 'GET /deployments/9', delayMs: 1000 },
    expected: false, // async 202 — polling for state transition; richer create response cannot eliminate it
  },
  {
    name: 'verification read of created resource by id',
    context: [
      { t: 0, call: 'cp_create_listener', status: 200 },
      { t: 700, call: 'cp_get_listener', status: 200 },
      { t: 4000, call: 'cp_create_route', status: 200 },
      { t: 4700, call: 'cp_get_route', status: 200 },
    ],
    pair: { write: 'cp_create_listener', read: 'cp_get_listener', delayMs: 700 },
    expected: true,
  },
  {
    name: 'unrelated audit read coincidentally adjacent',
    context: [
      { t: 0, call: 'POST /users', status: 201 },
      { t: 500, call: 'GET /users?role=admin', status: 200 },
      { t: 1100, call: 'DELETE /users/1', status: 204 },
    ],
    pair: { write: 'POST /users', read: 'GET /users?role=admin', delayMs: 500 },
    expected: false, // filtered admin listing feeding the delete decision, not verifying the create
  },
];

// ---------------------------------------------------------------------------
// Ollama structured-output call
// ---------------------------------------------------------------------------

async function chat(model, system, user, schema) {
  const start = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      format: schema,
      stream: false,
      think: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const ms = performance.now() - start;
  // Reasoning models may emit <think>...</think> before the JSON despite think:false
  let content = data.message.content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
  // Some models wrap JSON in markdown fences when the format grammar is not applied
  content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  // If an unclosed <think> remains, take everything after the last '}'-terminated JSON object
  if (content.startsWith('<think>')) {
    const m = content.match(/\{[\s\S]*\}/);
    content = m ? m[0] : content;
  }
  return { parsed: JSON.parse(content), ms };
}

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    match: { type: ['string', 'null'] },
  },
  required: ['match'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    is_verification_loop: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['is_verification_loop', 'reason'],
};

const SYSTEM_A = `You analyze API tool names from an MCP/JSON-RPC session.
Given a WRITE tool and a list of READ tools, identify which read tool returns the state of the same domain object the write tool modifies. Match on the domain object, not on string similarity. If none of the read tools operate on the same domain object, answer null.
Respond with JSON: {"match": "<tool name from the list>"} or {"match": null}.`;

const SYSTEM_B = `You analyze an AI agent's API call sequence captured by a proxy.
A heuristic flagged a write->read pair as a "verification loop". Definition: the agent writes a resource (success status), then reads back THE SAME resource it just wrote, and the read exists only because the write response did not return the full resource. If the write response had returned the complete resource, the read would be unnecessary. Reading the resource you just created/updated to confirm or obtain its state IS a verification loop — that is the default when the write succeeded and the read targets the same resource.
It is NOT a verification loop only when the evidence shows the read serves a different job:
- the write FAILED (4xx/5xx) and the read checks what state remains (error recovery)
- the write returned 202/async and the read repeats, polling for a state TRANSITION (a richer 202 response cannot help)
- the read targets a DIFFERENT resource, a child collection, or a filtered subset (query params) rather than the written resource itself
- the sequence shows a task boundary (e.g. tools/list re-discovery) and the read begins a new workflow that then modifies the resource again
Respond with JSON: {"is_verification_loop": <bool>, "reason": "<one sentence>"}.`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function pct(n, d) {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}% (${n}/${d})`;
}

// Heuristic baseline for Task A
let heurA = 0;
for (const c of TASK_A) {
  const got = heuristicMatch(c.write, c.reads.filter((r) => READ_VERBS.test(r)));
  if (got === c.expected) heurA++;
}

// Heuristic baseline for Task B: always says "verification loop" (that's why these were flagged)
const heurB = TASK_B.filter((c) => c.expected === true).length;

console.log(`Heuristic baseline — Task A: ${pct(heurA, TASK_A.length)}, Task B: ${pct(heurB, TASK_B.length)}\n`);

const results = [];

for (const model of MODELS) {
  console.log(`=== ${model} ===`);
  let aCorrect = 0;
  const aLatencies = [];
  const aFails = [];
  for (const c of TASK_A) {
    const user = `WRITE tool: ${c.write}\nREAD tools: ${JSON.stringify(c.reads)}`;
    try {
      const { parsed, ms } = await chat(model, SYSTEM_A, user, MATCH_SCHEMA);
      aLatencies.push(ms);
      // Normalize: some models emit the string "null" instead of JSON null
      const got = parsed.match === 'null' ? null : (parsed.match ?? null);
      if (got === c.expected) aCorrect++;
      else aFails.push(`  A ✗ ${c.write}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.expected)}`);
    } catch (e) {
      aFails.push(`  A ✗ ${c.write}: ERROR ${e.message}`);
    }
  }

  let bCorrect = 0;
  const bLatencies = [];
  const bFails = [];
  for (const c of TASK_B) {
    const ctx = c.context.map((s) => `  t=${s.t}ms  ${s.call}  -> ${s.status}`).join('\n');
    const user = `Call sequence:\n${ctx}\n\nFlagged pair: ${c.pair.write} -> ${c.pair.read} (${c.pair.delayMs}ms apart)\nIs this a true verification loop?`;
    try {
      const { parsed, ms } = await chat(model, SYSTEM_B, user, VERIFY_SCHEMA);
      bLatencies.push(ms);
      if (parsed.is_verification_loop === c.expected) bCorrect++;
      else bFails.push(`  B ✗ ${c.name}: got ${parsed.is_verification_loop}, want ${c.expected} — "${parsed.reason}"`);
    } catch (e) {
      bFails.push(`  B ✗ ${c.name}: ERROR ${e.message}`);
    }
  }

  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b) / xs.length) : 0);
  console.log(`Task A (tool match):   ${pct(aCorrect, TASK_A.length)}  avg ${avg(aLatencies)}ms/call`);
  console.log(`Task B (verify judge): ${pct(bCorrect, TASK_B.length)}  avg ${avg(bLatencies)}ms/call`);
  for (const f of [...aFails, ...bFails]) console.log(f);
  console.log();
  results.push({ model, aCorrect, bCorrect, aAvgMs: avg(aLatencies), bAvgMs: avg(bLatencies) });
}

console.log('=== SUMMARY ===');
console.log(`heuristic           A ${pct(heurA, TASK_A.length).padEnd(12)} B ${pct(heurB, TASK_B.length)}`);
for (const r of results) {
  console.log(
    `${r.model.padEnd(18)}  A ${pct(r.aCorrect, TASK_A.length).padEnd(12)} B ${pct(r.bCorrect, TASK_B.length).padEnd(12)} latency A ${r.aAvgMs}ms B ${r.bAvgMs}ms`,
  );
}
