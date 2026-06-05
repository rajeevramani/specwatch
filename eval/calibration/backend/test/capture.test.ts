import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSpec } from '../../packages/agentready-scoring/src/index.js';
import { MockLlmClient } from '../../runner/llm.js';
import { GOLD_MOCK_PLANS } from '../../runner/mock-plans.js';
import { runVariant } from '../../runner/runner.js';
import { captureVariant, analyzeTask, type CaptureArtifact } from '../../runner/capture.js';
import { TASKS } from '../../tasks/index.js';

/**
 * Specwatch capture acceptance test (specwatch-13a).
 *
 * Proves — with the deterministic MOCK agent and ZERO paid calls — that the
 * runner's captured agent traffic, replayed through specwatch's OWN analysis
 * library in consumer=agent mode, yields a per-(variant, task) runtime telemetry
 * artifact with the expected fields and keys for the analysis join.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GOLD_SPEC = resolve(here, '../../specs/gold.yaml');

function loadGold(): any {
  return parseSpec(readFileSync(GOLD_SPEC, 'utf8'));
}

async function goldRun() {
  const client = new MockLlmClient(GOLD_MOCK_PLANS, 'mock:test');
  return runVariant({ variant: 'gold', spec: loadGold(), client });
}

describe('captureVariant (specwatch capture per variant, consumer=agent)', () => {
  it('produces a capture artifact keyed to variant + task with telemetry fields', async () => {
    const run = await goldRun();
    const artifact: CaptureArtifact = captureVariant(run);

    // Top-level artifact shape.
    expect(artifact.source).toBe('replay');
    expect(artifact.consumer).toBe('agent');
    expect(typeof artifact.generatedAt).toBe('string');

    // Variant-level rollup, keyed to the variant.
    const v = artifact.variant;
    expect(v.variant).toBe('gold');
    expect(v.agent).toBe('mock:test');
    expect(v.taskCount).toBe(TASKS.length);
    expect(v.tasks.length).toBe(TASKS.length);
    expect(v.totalCalls).toBeGreaterThan(0);
    expect(typeof v.totalVerificationLoops).toBe('number');
    expect(typeof v.totalWastedRequests).toBe('number');

    // Per-task telemetry: every expected key present and keyed to variant+task.
    const taskIds = new Set(TASKS.map((t) => t.id));
    for (const t of v.tasks) {
      expect(t.variant).toBe('gold');
      expect(taskIds.has(t.taskId)).toBe(true);

      // Required telemetry fields (the analysis-join contract).
      expect(typeof t.success).toBe('boolean');
      expect(typeof t.callsPerTask).toBe('number');
      expect(t.callsPerTask).toBeGreaterThan(0);
      expect(typeof t.verificationLoops).toBe('number');
      expect(typeof t.wastedRequests).toBe('number');
      // responseCompleteness is number|null.
      expect(t.responseCompleteness === null || typeof t.responseCompleteness === 'number').toBe(
        true,
      );
      expect(Array.isArray(t.thinEndpoints)).toBe(true);
      expect(t.commonNextSteps).toBeTypeOf('object');
    }

    // The variant+task composite key is unique across tasks.
    const keys = v.tasks.map((t) => `${t.variant}::${t.taskId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('callsPerTask matches the runner record (specwatch sees the same traffic)', async () => {
    const run = await goldRun();
    const artifact = captureVariant(run);
    for (const rec of run.records) {
      const tel = artifact.variant.tasks.find((t) => t.taskId === rec.taskId)!;
      expect(tel.callsPerTask).toBe(rec.callCount);
      expect(tel.success).toBe(rec.success);
    }
  });

  it('detects a verification loop when the agent re-reads what it just wrote', () => {
    // A synthetic task transcript: create an order, then GET it back (a classic
    // verification loop specwatch is designed to flag). We feed it straight to
    // analyzeTask to exercise specwatch's real sequence analysis.
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const record = {
      variant: 'synthetic',
      taskId: 'verify_loop',
      success: true,
      detail: '',
      callCount: 2,
      steps: 2,
      truncated: false,
      transcript: [
        { kind: 'prompt' as const, text: 'do it' },
        {
          kind: 'assistant' as const,
          text: '',
          toolCalls: [
            {
              id: 'a',
              name: 'createOrder',
              input: { customerId: 'c1' },
              status: 201,
              response: JSON.stringify({ id: 'o1', customer_id: 'c1', status: 'pending' }),
              isError: false,
              httpMethod: 'POST',
              rawPath: '/orders',
              normalizedPath: '/orders',
              capturedAt: at(0),
            },
            {
              id: 'b',
              name: 'getOrder',
              input: { orderId: 'o1' },
              status: 200,
              response: JSON.stringify({
                id: 'o1',
                customer_id: 'c1',
                status: 'pending',
                created_at: 't',
              }),
              isError: false,
              httpMethod: 'GET',
              rawPath: '/orders/o1',
              normalizedPath: '/orders/{orderId}',
              capturedAt: at(500),
            },
          ],
        },
      ],
    };

    const tel = analyzeTask(record);
    expect(tel.variant).toBe('synthetic');
    expect(tel.taskId).toBe('verify_loop');
    // specwatch classifies POST /orders -> GET /orders/{orderId} as a verification loop.
    expect(tel.verificationLoops).toBeGreaterThanOrEqual(1);
    expect(tel.wastedRequests).toBeGreaterThanOrEqual(1);
    // commonNextSteps records the observed successor.
    expect(tel.commonNextSteps['POST /orders']).toContain('GET /orders/{orderId}');
  });
});
