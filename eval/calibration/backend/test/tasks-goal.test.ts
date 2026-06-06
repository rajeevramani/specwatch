import { describe, it, expect } from 'vitest';
import { TASKS, GOAL_TASKS, type TruthSnapshot } from '../../tasks/index.js';

/**
 * Goal task set (specwatch-ewk): domain-intent prompts that force the agent to
 * use the spec to map intent -> operations, reusing the mechanical asserts +
 * adding goal-only tasks for statistical power.
 */

const EMPTY: TruthSnapshot = { customers: [], orders: [], line_items: [] };

describe('GOAL_TASKS', () => {
  it('has more tasks than the mechanical set (added for power)', () => {
    expect(GOAL_TASKS.length).toBeGreaterThan(TASKS.length);
    expect(GOAL_TASKS.length).toBe(8);
  });

  it('ids are unique and the 5 mechanical ids are re-framed (not duplicated wording)', () => {
    const ids = GOAL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of TASKS) {
      const goal = GOAL_TASKS.find((t) => t.id === m.id)!;
      expect(goal, `goal set should re-frame ${m.id}`).toBeDefined();
      // Re-framed prompt differs from the mechanical one (it's goal-level, indirect).
      expect(goal.prompt).not.toBe(m.prompt);
    }
  });

  it('every task has a prompt, >=2 documented steps, and a pure assert', () => {
    for (const t of GOAL_TASKS) {
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.steps.length).toBeGreaterThanOrEqual(2);
      // Pure: same snapshot -> same verdict.
      const a = t.assert(EMPTY);
      const b = t.assert(EMPTY);
      expect(a).toEqual(b);
      expect(a.taskId).toBe(t.id);
    }
  });

  it('create/update tasks fail on an empty snapshot (no no-op passes)', () => {
    // Every goal task EXCEPT the deletion task requires positive state, so an
    // empty snapshot (nothing done) must fail. The deletion task is checked below.
    for (const t of GOAL_TASKS) {
      if (t.id === 't7_erase_mistaken_order') continue;
      expect(t.assert(EMPTY).pass, `${t.id} should fail when nothing was done`).toBe(false);
    }
  });

  it('the deletion task is satisfied by absence, not a no-op (fails when the order is present)', () => {
    const del = GOAL_TASKS.find((t) => t.id === 't7_erase_mistaken_order')!;
    // Present in the seed -> must be deleted -> fails until then.
    const withOrder: TruthSnapshot = {
      customers: [],
      orders: [{ id: 'ord_002', customer_id: 'cus_001', status: 'pending', created_at: '' }],
      line_items: [],
    };
    expect(del.assert(withOrder).pass).toBe(false);
    // Removed -> satisfied.
    expect(del.assert(EMPTY).pass).toBe(true);
  });

  it('goal prompts avoid naming HTTP operations (intent, not procedure)', () => {
    for (const t of GOAL_TASKS) {
      // Indirect by design: should not spell out REST verbs/paths the way `steps` do.
      expect(t.prompt).not.toMatch(/\bPOST\b|\bPUT\b|\bDELETE\b|\/orders|\/customers|\/line-items/);
    }
  });
});
