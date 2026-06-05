import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSpec } from '../../packages/agentready-scoring/src/index.js';
import { specToTools, toWireTools } from '../../runner/tools.js';
import { MockLlmClient } from '../../runner/llm.js';
import { GOLD_MOCK_PLANS } from '../../runner/mock-plans.js';
import { runVariant, SYSTEM_PROMPT } from '../../runner/runner.js';
import { TASKS } from '../../tasks/index.js';

/**
 * Dry-run acceptance test for the agent runner (specwatch-ajn).
 *
 * Proves — with the deterministic MOCK client and ZERO paid calls — that the
 * full pipeline runs end-to-end on the gold variant and produces a per-(variant,
 * task) record of success (from `/__truth`), call count, and transcript.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GOLD_SPEC = resolve(here, '../../specs/gold.yaml');

function loadGold(): any {
  return parseSpec(readFileSync(GOLD_SPEC, 'utf8'));
}

describe('specToTools (OpenAPI -> function-calling)', () => {
  const tools = specToTools(loadGold());

  it('emits one tool per operation with spec-derived names', () => {
    const names = tools.map((t) => t.name);
    // Gold operationIds flow through verbatim.
    for (const expected of [
      'createCustomer',
      'createOrder',
      'cancelOrder',
      'createLineItem',
      'updateOrder',
      'updateLineItem',
      'listOrders',
      'listLineItems',
      'updateCustomer',
      'deleteCustomer',
    ]) {
      expect(names).toContain(expected);
    }
    // 1 tool per operation: gold has 17 operations (health + full CRUD across
    // customers/orders/line-items + the cancel action).
    expect(tools.length).toBe(17);
  });

  it('takes the tool description straight from the spec', () => {
    const createCustomer = tools.find((t) => t.name === 'createCustomer')!;
    expect(createCustomer.description).toContain('Create a customer');
    expect(createCustomer.description).toMatch(/POST \/customers/);
  });

  it('builds input schemas from params + request body, $refs resolved', () => {
    const createCustomer = tools.find((t) => t.name === 'createCustomer')!;
    expect(createCustomer.input_schema.properties).toHaveProperty('name');
    expect(createCustomer.input_schema.properties).toHaveProperty('email');
    expect(createCustomer.input_schema.required).toEqual(expect.arrayContaining(['name', 'email']));

    const updateOrder = tools.find((t) => t.name === 'updateOrder')!;
    // path param + body field both present; path param required.
    expect(updateOrder.input_schema.properties).toHaveProperty('orderId');
    expect(updateOrder.input_schema.properties).toHaveProperty('status');
    expect(updateOrder.input_schema.required).toContain('orderId');
    // No leftover $ref in the resolved status schema.
    expect(JSON.stringify(updateOrder.input_schema)).not.toContain('$ref');
  });

  it('strips routing metadata for the wire shape', () => {
    const wire = toWireTools(tools);
    for (const t of wire) {
      expect(t).not.toHaveProperty('_http');
      expect(t).toHaveProperty('input_schema');
    }
  });
});

describe('runVariant on gold (mock agent, no paid calls)', () => {
  it('runs the full a7n task set end-to-end and every task succeeds', async () => {
    const client = new MockLlmClient(GOLD_MOCK_PLANS, 'mock:test');
    const result = await runVariant({ variant: 'gold', spec: loadGold(), client });

    expect(result.variant).toBe('gold');
    expect(result.agent).toBe('mock:test');
    expect(result.records.length).toBe(TASKS.length);

    // Acceptance: per-(variant, task) record with success/callCount/transcript.
    for (const r of result.records) {
      expect(r.variant).toBe('gold');
      expect(typeof r.success).toBe('boolean');
      expect(r.callCount).toBeGreaterThan(0);
      expect(r.transcript.length).toBeGreaterThan(0);
      expect(r.transcript[0]).toEqual({ kind: 'prompt', text: expect.any(String) });
    }

    // The competent mock satisfies every task against the gold variant.
    expect(result.passCount).toBe(TASKS.length);
    expect(result.failCount).toBe(0);
  });

  it('records ground-truth success from /__truth, not the agent self-report', async () => {
    const client = new MockLlmClient(GOLD_MOCK_PLANS, 'mock:test');
    const result = await runVariant({ variant: 'gold', spec: loadGold(), client });
    const t1 = result.records.find((r) => r.taskId === 't1_onboard_and_cancel')!;
    expect(t1.success).toBe(true);
    expect(t1.detail).toMatch(/cancelled/);
    // The transcript captured the actual HTTP calls + backend responses.
    const calls = t1.transcript.flatMap((e) => (e.kind === 'assistant' ? e.toolCalls : []));
    expect(calls.map((c) => c.name)).toEqual(['createCustomer', 'createOrder', 'cancelOrder']);
    expect(calls.every((c) => c.status !== null && c.status < 400)).toBe(true);
  });

  it('is reproducible: a rerun yields identical success + call counts', async () => {
    const run = () => runVariant({ variant: 'gold', spec: loadGold(), client: new MockLlmClient(GOLD_MOCK_PLANS) });
    const a = await run();
    const b = await run();
    const shape = (r: Awaited<ReturnType<typeof run>>) =>
      r.records.map((rec) => ({ id: rec.taskId, ok: rec.success, calls: rec.callCount, steps: rec.steps }));
    expect(shape(a)).toEqual(shape(b));
  });

  it('uses the fixed system prompt for the agent (a constant)', () => {
    expect(SYSTEM_PROMPT).toContain('automated API client');
  });
});

describe('runVariant degradation sanity (a no-op agent fails)', () => {
  it('records failures when the agent makes no useful calls', async () => {
    // Empty plans => mock ends every turn immediately (a "did nothing" agent).
    const client = new MockLlmClient({}, 'mock:noop');
    const result = await runVariant({ variant: 'gold', spec: loadGold(), client });
    // Tasks whose end-state requires writes must fail; none should pass.
    expect(result.passCount).toBe(0);
    for (const r of result.records) {
      expect(r.callCount).toBe(0);
      expect(r.success).toBe(false);
    }
  });
});
