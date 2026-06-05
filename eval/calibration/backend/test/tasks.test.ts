import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { TASKS, getTask, checkTasks, checkTask } from '../../tasks/index.js';
import type { TruthSnapshot } from '../../tasks/index.js';

/**
 * Happy-path tests for the calibration task set (specwatch-a7n).
 *
 * For each task we drive the backend through its intended dependent calls via
 * the PUBLIC API, then read `/__truth` and assert the task's ground-truth
 * assertion passes. We also assert a clean (un-touched) backend FAILS the
 * create/mutate tasks — proving the assertion is grounded in real end-state and
 * not a self-report rubber-stamp.
 */

async function truthOf(app: Express): Promise<TruthSnapshot> {
  const res = await request(app).get('/__truth');
  expect(res.status).toBe(200);
  return res.body as TruthSnapshot;
}

describe('calibration task set — shape', () => {
  it('defines at least 4 multi-step tasks', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(4);
  });

  it('every task documents at least 3 dependent steps and a unique id', () => {
    const ids = new Set<string>();
    for (const t of TASKS) {
      expect(t.steps.length, `${t.id} steps`).toBeGreaterThanOrEqual(3);
      expect(t.prompt.length, `${t.id} prompt`).toBeGreaterThan(0);
      expect(ids.has(t.id), `${t.id} duplicate`).toBe(false);
      ids.add(t.id);
    }
  });
});

describe('task assertions are grounded in /__truth, not self-report', () => {
  it('a fresh backend fails the create/mutate tasks (seed alone does not satisfy them)', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const report = checkTasks(await truthOf(app));
    // Only the seed is present; none of the marker tasks are satisfied.
    expect(report.allPassed).toBe(false);
    // t1/t2/t5 require markers absent from the seed -> must fail.
    const byId = Object.fromEntries(report.results.map((r) => [r.taskId, r.pass]));
    expect(byId['t1_onboard_and_cancel']).toBe(false);
    expect(byId['t2_place_order_and_pay']).toBe(false);
    expect(byId['t5_onboard_rename_offboard']).toBe(false);
  });
});

describe('t1_onboard_and_cancel happy path', () => {
  let app: Express;
  beforeEach(() => {
    app = createApp({ file: ':memory:' }).app;
  });

  it('passes after create customer -> create order -> cancel order', async () => {
    const cus = await request(app)
      .post('/customers')
      .send({ name: 'Margaret Hamilton', email: 'margaret.hamilton@calib.test' });
    expect(cus.status).toBe(201);

    const ord = await request(app).post('/orders').send({ customer_id: cus.body.id });
    expect(ord.status).toBe(201);

    const cancelled = await request(app).post(`/orders/${ord.body.id}/cancel`).send();
    expect(cancelled.status).toBe(200);

    const result = checkTask('t1_onboard_and_cancel', await truthOf(app));
    expect(result.pass, result.detail).toBe(true);
  });

  it('fails if the order is created but never cancelled', async () => {
    const cus = await request(app)
      .post('/customers')
      .send({ name: 'Margaret Hamilton', email: 'margaret.hamilton@calib.test' });
    await request(app).post('/orders').send({ customer_id: cus.body.id });

    const result = checkTask('t1_onboard_and_cancel', await truthOf(app));
    expect(result.pass).toBe(false);
  });
});

describe('t2_place_order_and_pay happy path', () => {
  it('passes after create -> order -> two line-items -> mark paid', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const cus = await request(app)
      .post('/customers')
      .send({ name: 'Katherine Johnson', email: 'katherine.johnson@calib.test' });
    const ord = await request(app).post('/orders').send({ customer_id: cus.body.id });
    await request(app)
      .post('/line-items')
      .send({ order_id: ord.body.id, sku: 'CALIB-ALPHA', quantity: 3, unit_price: 1000 });
    await request(app)
      .post('/line-items')
      .send({ order_id: ord.body.id, sku: 'CALIB-BETA', quantity: 1, unit_price: 4999 });
    const paid = await request(app).put(`/orders/${ord.body.id}`).send({ status: 'paid' });
    expect(paid.status).toBe(200);

    const result = checkTask('t2_place_order_and_pay', await truthOf(app));
    expect(result.pass, result.detail).toBe(true);
  });

  it('fails if a line-item quantity is wrong', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const cus = await request(app)
      .post('/customers')
      .send({ name: 'Katherine Johnson', email: 'katherine.johnson@calib.test' });
    const ord = await request(app).post('/orders').send({ customer_id: cus.body.id });
    await request(app)
      .post('/line-items')
      .send({ order_id: ord.body.id, sku: 'CALIB-ALPHA', quantity: 99, unit_price: 1000 });
    await request(app)
      .post('/line-items')
      .send({ order_id: ord.body.id, sku: 'CALIB-BETA', quantity: 1, unit_price: 4999 });
    await request(app).put(`/orders/${ord.body.id}`).send({ status: 'paid' });

    const result = checkTask('t2_place_order_and_pay', await truthOf(app));
    expect(result.pass).toBe(false);
  });
});

describe('t3_fulfil_pending_order happy path (seeded order)', () => {
  it('passes after advancing Ada\'s pending order to shipped', async () => {
    const app = createApp({ file: ':memory:' }).app;
    // Resolve Ada via the public API, find her pending order.
    const customers = await request(app).get('/customers');
    const ada = (customers.body as Array<{ id: string; email: string }>).find(
      (c) => c.email === 'ada@example.com',
    )!;
    const orders = await request(app).get(`/orders?customer_id=${ada.id}`);
    const pending = (orders.body as Array<{ id: string; status: string }>).find(
      (o) => o.status === 'pending',
    )!;
    await request(app).put(`/orders/${pending.id}`).send({ status: 'paid' });
    await request(app).put(`/orders/${pending.id}`).send({ status: 'shipped' });

    const result = checkTask('t3_fulfil_pending_order', await truthOf(app));
    expect(result.pass, result.detail).toBe(true);
  });

  it('fails on a fresh backend where the order is still pending', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const result = checkTask('t3_fulfil_pending_order', await truthOf(app));
    expect(result.pass).toBe(false);
  });
});

describe('t4_correct_line_item_quantity happy path (seeded line-item)', () => {
  it('passes after updating WIDGET-A on ord_001 to quantity 7', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const items = await request(app).get('/line-items?order_id=ord_001');
    const widgetA = (items.body as Array<{ id: string; sku: string }>).find(
      (li) => li.sku === 'WIDGET-A',
    )!;
    const upd = await request(app)
      .put(`/line-items/${widgetA.id}`)
      .send({ sku: 'WIDGET-A', quantity: 7, unit_price: 1500 });
    expect(upd.status).toBe(200);

    const result = checkTask('t4_correct_line_item_quantity', await truthOf(app));
    expect(result.pass, result.detail).toBe(true);
  });

  it('fails on a fresh backend (seed quantity is 2, not 7)', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const result = checkTask('t4_correct_line_item_quantity', await truthOf(app));
    expect(result.pass).toBe(false);
  });
});

describe('t5_onboard_rename_offboard happy path', () => {
  it('passes after create keeper -> create reject -> rename keeper -> delete reject', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const keeper = await request(app)
      .post('/customers')
      .send({ name: 'Temp Keeper', email: 'keep.user@calib.test' });
    const reject = await request(app)
      .post('/customers')
      .send({ name: 'Temp Reject', email: 'reject.user@calib.test' });
    await request(app)
      .put(`/customers/${keeper.body.id}`)
      .send({ name: 'Permanent Keeper', email: 'keep.user@calib.test' });
    const del = await request(app).delete(`/customers/${reject.body.id}`);
    expect(del.status).toBe(204);

    const result = checkTask('t5_onboard_rename_offboard', await truthOf(app));
    expect(result.pass, result.detail).toBe(true);
  });

  it('fails on a fresh backend (no-op cannot satisfy the positive end-state)', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const result = checkTask('t5_onboard_rename_offboard', await truthOf(app));
    expect(result.pass).toBe(false);
  });

  it('fails if the keeper is renamed but the reject is never deleted', async () => {
    const app = createApp({ file: ':memory:' }).app;
    const keeper = await request(app)
      .post('/customers')
      .send({ name: 'Temp Keeper', email: 'keep.user@calib.test' });
    await request(app)
      .post('/customers')
      .send({ name: 'Temp Reject', email: 'reject.user@calib.test' });
    await request(app)
      .put(`/customers/${keeper.body.id}`)
      .send({ name: 'Permanent Keeper', email: 'keep.user@calib.test' });
    const result = checkTask('t5_onboard_rename_offboard', await truthOf(app));
    expect(result.pass).toBe(false);
  });
});

describe('full task set passes once every happy path is driven', () => {
  it('checkTasks reports allPassed against one backend run through all tasks', async () => {
    const app = createApp({ file: ':memory:' }).app;

    // t1
    let cus = await request(app)
      .post('/customers')
      .send({ name: 'Margaret Hamilton', email: 'margaret.hamilton@calib.test' });
    let ord = await request(app).post('/orders').send({ customer_id: cus.body.id });
    await request(app).post(`/orders/${ord.body.id}/cancel`).send();

    // t2
    cus = await request(app)
      .post('/customers')
      .send({ name: 'Katherine Johnson', email: 'katherine.johnson@calib.test' });
    ord = await request(app).post('/orders').send({ customer_id: cus.body.id });
    await request(app)
      .post('/line-items')
      .send({ order_id: ord.body.id, sku: 'CALIB-ALPHA', quantity: 3, unit_price: 1000 });
    await request(app)
      .post('/line-items')
      .send({ order_id: ord.body.id, sku: 'CALIB-BETA', quantity: 1, unit_price: 4999 });
    await request(app).put(`/orders/${ord.body.id}`).send({ status: 'paid' });

    // t3 — Ada's pending order to shipped
    const list = await request(app).get('/customers');
    const ada = (list.body as Array<{ id: string; email: string }>).find(
      (c) => c.email === 'ada@example.com',
    )!;
    const adaOrders = await request(app).get(`/orders?customer_id=${ada.id}`);
    const pending = (adaOrders.body as Array<{ id: string; status: string }>).find(
      (o) => o.status === 'pending',
    )!;
    await request(app).put(`/orders/${pending.id}`).send({ status: 'paid' });
    await request(app).put(`/orders/${pending.id}`).send({ status: 'shipped' });

    // t4 — correct WIDGET-A on ord_001
    const items = await request(app).get('/line-items?order_id=ord_001');
    const widgetA = (items.body as Array<{ id: string; sku: string }>).find(
      (li) => li.sku === 'WIDGET-A',
    )!;
    await request(app)
      .put(`/line-items/${widgetA.id}`)
      .send({ sku: 'WIDGET-A', quantity: 7, unit_price: 1500 });

    // t5 — onboard two, rename one, off-board the other
    const keeper = await request(app)
      .post('/customers')
      .send({ name: 'Temp Keeper', email: 'keep.user@calib.test' });
    const reject = await request(app)
      .post('/customers')
      .send({ name: 'Temp Reject', email: 'reject.user@calib.test' });
    await request(app)
      .put(`/customers/${keeper.body.id}`)
      .send({ name: 'Permanent Keeper', email: 'keep.user@calib.test' });
    await request(app).delete(`/customers/${reject.body.id}`);

    const report = checkTasks(await truthOf(app));
    const failed = report.results.filter((r) => !r.pass).map((r) => `${r.taskId}: ${r.detail}`);
    expect(failed, failed.join(' | ')).toEqual([]);
    expect(report.allPassed).toBe(true);
  });
});

// Touch getTask so the import is exercised and unknown ids throw.
describe('getTask', () => {
  it('returns a known task and throws on unknown', () => {
    expect(getTask('t1_onboard_and_cancel').id).toBe('t1_onboard_and_cancel');
    expect(() => getTask('nope')).toThrow(/unknown calibration task/);
  });
});
