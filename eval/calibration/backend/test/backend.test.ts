import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { SEED } from '../src/db/seed.js';

function makeApp(thinResponses = false) {
  return createApp({ file: ':memory:', thinResponses }).app;
}

describe('deterministic seed', () => {
  it('produces identical seed state on every boot', async () => {
    const a = await request(makeApp()).get('/__truth');
    const b = await request(makeApp()).get('/__truth');
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  it('seeds the expected fixed rows', async () => {
    const res = await request(makeApp()).get('/__truth');
    expect(res.body.customers).toHaveLength(SEED.CUSTOMERS.length);
    expect(res.body.orders).toHaveLength(SEED.ORDERS.length);
    expect(res.body.line_items).toHaveLength(SEED.LINE_ITEMS.length);
    expect(res.body.customers[0]).toMatchObject({ id: 'cus_001', name: 'Ada Lovelace' });
    expect(res.body.customers[0].created_at).toBe(SEED.SEED_TS);
  });
});

describe('customers CRUD', () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it('lists and reads seeded customers', async () => {
    const list = await request(app).get('/customers');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);

    const one = await request(app).get('/customers/cus_001');
    expect(one.status).toBe(200);
    expect(one.body.email).toBe('ada@example.com');
  });

  it('404s on unknown customer', async () => {
    const res = await request(app).get('/customers/cus_999');
    expect(res.status).toBe(404);
  });

  it('creates, updates, and deletes a customer', async () => {
    const created = await request(app)
      .post('/customers')
      .send({ name: 'Edsger Dijkstra', email: 'edsger@example.com' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe('cus_004');

    const updated = await request(app)
      .put(`/customers/${created.body.id}`)
      .send({ name: 'E. Dijkstra', email: 'edsger@example.com' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('E. Dijkstra');

    const del = await request(app).delete(`/customers/${created.body.id}`);
    expect(del.status).toBe(204);

    const gone = await request(app).get(`/customers/${created.body.id}`);
    expect(gone.status).toBe(404);
  });

  it('rejects invalid create body', async () => {
    const res = await request(app).post('/customers').send({ name: 'no email' });
    expect(res.status).toBe(400);
  });
});

describe('orders + line-items CRUD', () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it('creates an order for an existing customer and cancels it', async () => {
    const created = await request(app).post('/orders').send({ customer_id: 'cus_001' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');

    const cancelled = await request(app).post(`/orders/${created.body.id}/cancel`).send();
    expect(cancelled.status).toBe(200);

    const fetched = await request(app).get(`/orders/${created.body.id}`);
    expect(fetched.body.status).toBe('cancelled');
  });

  it('rejects an order for a non-existent customer', async () => {
    const res = await request(app).post('/orders').send({ customer_id: 'cus_999' });
    expect(res.status).toBe(422);
  });

  it('filters orders by customer_id', async () => {
    const res = await request(app).get('/orders?customer_id=cus_001');
    expect(res.status).toBe(200);
    expect(res.body.every((o: { customer_id: string }) => o.customer_id === 'cus_001')).toBe(true);
    expect(res.body.length).toBe(2);
  });

  it('creates a line item against an order', async () => {
    const created = await request(app)
      .post('/line-items')
      .send({ order_id: 'ord_002', sku: 'WIDGET-Z', quantity: 3, unit_price: 500 });
    expect(created.status).toBe(201);

    const list = await request(app).get('/line-items?order_id=ord_002');
    expect(list.body.some((li: { sku: string }) => li.sku === 'WIDGET-Z')).toBe(true);
  });

  it('rejects a line item with non-positive quantity', async () => {
    const res = await request(app)
      .post('/line-items')
      .send({ order_id: 'ord_001', sku: 'X', quantity: 0, unit_price: 100 });
    expect(res.status).toBe(400);
  });
});

describe('/__truth readback', () => {
  it('reflects mutations made through the public API', async () => {
    const app = makeApp();
    const before = await request(app).get('/__truth/counts');
    expect(before.body.customers).toBe(3);

    await request(app).post('/customers').send({ name: 'New', email: 'new@example.com' });

    const after = await request(app).get('/__truth/counts');
    expect(after.body.customers).toBe(4);

    const truth = await request(app).get('/__truth/customers');
    expect(truth.body.some((c: { email: string }) => c.email === 'new@example.com')).toBe(true);
  });
});

describe('THIN_RESPONSES toggle', () => {
  it('full responses (=0) return the complete object', async () => {
    const app = makeApp(false);
    const res = await request(app)
      .post('/customers')
      .send({ name: 'Full Body', email: 'full@example.com' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'cus_004', name: 'Full Body', email: 'full@example.com' });
    expect(res.body.created_at).toBeDefined();
  });

  it('thin responses (=1) return id-only bodies', async () => {
    const app = makeApp(true);
    const res = await request(app)
      .post('/customers')
      .send({ name: 'Thin Body', email: 'thin@example.com' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['id']);
    expect(res.body.id).toBe('cus_004');
  });

  it('thin toggle also applies to PUT and order cancel', async () => {
    const app = makeApp(true);
    const put = await request(app)
      .put('/customers/cus_001')
      .send({ name: 'Renamed', email: 'ada@example.com' });
    expect(Object.keys(put.body)).toEqual(['id']);

    const cancel = await request(app).post('/orders/ord_002/cancel').send();
    expect(Object.keys(cancel.body)).toEqual(['id']);
  });

  it('health endpoint reports the toggle state', async () => {
    expect((await request(makeApp(true)).get('/health')).body.thinResponses).toBe(true);
    expect((await request(makeApp(false)).get('/health')).body.thinResponses).toBe(false);
  });
});
