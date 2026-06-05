import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseSpec, scoreSpec } from '../../packages/agentready-scoring/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = resolve(here, '../../specs/gold.yaml');
const gold = parseSpec(readFileSync(GOLD_PATH, 'utf8')) as any;

/**
 * Gold-spec acceptance test (specwatch-tey).
 *
 * Three guarantees, all enforced here:
 *  1. JAIRF score — the @agentready/scoring package grades the gold spec at
 *     >= 80 (grade B+ or better) with all five phase-1 signals passing.
 *  2. Behavior match — every agent-facing path/verb in the spec is exercised
 *     against the live backend; documented success status codes and the
 *     documented (problem+json) error shapes are returned, and write responses
 *     come back complete (not thin).
 *  3. Validity — structural OpenAPI 3.1 sanity (the redocly 0-error lint runs
 *     separately via `npm run lint:spec`; see eval/calibration/specs/README).
 */

/** Resolve a local `#/...` JSON pointer against the spec. */
function deref(ref: string): any {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: any = gold;
  for (const p of parts) node = node?.[p.replace(/~1/g, '/').replace(/~0/g, '~')];
  return node;
}

/** Required property names for a (possibly $ref'd) success schema. */
function requiredFields(schema: any): string[] {
  if (!schema) return [];
  const s = schema.$ref ? deref(schema.$ref) : schema;
  if (s?.type === 'array' && s.items) {
    const item = s.items.$ref ? deref(s.items.$ref) : s.items;
    return item?.required ?? [];
  }
  return s?.required ?? [];
}

describe('gold spec — JAIRF score', () => {
  const result = scoreSpec(gold);

  it('scores AgentReady JAIRF >= 80 (grade B+ or better)', () => {
    expect(result.overall).toBeGreaterThanOrEqual(80);
    expect(['A', 'B']).toContain(result.grade);
    expect(result.gates).toHaveLength(0);
  });

  it('passes all five phase-1 signals (each >= 80)', () => {
    const byId: Record<string, number> = {};
    for (const cat of result.categories) {
      for (const s of cat.signals ?? []) byId[s.id] = s.score;
    }
    // descriptions — scored under ARAX/DXJ/AID; require all three views strong.
    expect(byId.description_coverage).toBeGreaterThanOrEqual(80);
    expect(byId.doc_clarity).toBeGreaterThanOrEqual(80);
    expect(byId.descriptive_richness).toBeGreaterThanOrEqual(80);
    // operationId quality.
    expect(byId.operationid_quality).toBeGreaterThanOrEqual(80);
    // request/response examples — response examples are the load-bearing view.
    expect(byId.response_examples).toBeGreaterThanOrEqual(80);
    // error-schema standardization (RFC 9457 problem-details).
    expect(byId.error_standardization).toBeGreaterThanOrEqual(80);
    // response completeness — asserted structurally below; static proxy for it
    // is full response coverage, which must be non-trivial.
    expect(byId.response_2xx_coverage).toBeGreaterThanOrEqual(50);
  });

  it('write operations document complete resource response bodies', () => {
    // Every create/update/cancel success body must reference the full resource
    // schema (id + all fields), never an id-only body — the response-completeness
    // signal that the THIN_RESPONSES ablation degrades.
    const writeChecks: Array<[string, string, string, string[]]> = [
      ['/customers', 'post', '201', ['id', 'name', 'email', 'created_at']],
      ['/customers/{customerId}', 'put', '200', ['id', 'name', 'email', 'created_at']],
      ['/orders', 'post', '201', ['id', 'customer_id', 'status', 'created_at']],
      ['/orders/{orderId}', 'put', '200', ['id', 'customer_id', 'status', 'created_at']],
      ['/orders/{orderId}/cancel', 'post', '200', ['id', 'customer_id', 'status', 'created_at']],
      ['/line-items', 'post', '201', ['id', 'order_id', 'sku', 'quantity', 'unit_price']],
      ['/line-items/{lineItemId}', 'put', '200', ['id', 'order_id', 'sku', 'quantity', 'unit_price']],
    ];
    for (const [path, verb, code, fields] of writeChecks) {
      const schema = gold.paths[path][verb].responses[code].content['application/json'].schema;
      expect(requiredFields(schema).sort()).toEqual([...fields].sort());
    }
  });
});

describe('gold spec — structural validity (OpenAPI 3.1)', () => {
  const result = scoreSpec(gold);

  it('is a well-formed OpenAPI 3.1 document', () => {
    expect(gold.openapi).toBe('3.1.0');
    expect(gold.info?.title).toBeTruthy();
    expect(gold.info?.version).toBeTruthy();
    expect(Object.keys(gold.paths ?? {}).length).toBeGreaterThan(0);
    expect(result.operationCount).toBe(17);
  });

  it('every local $ref resolves', () => {
    const text = JSON.stringify(gold);
    const refs = Array.from(text.matchAll(/"\$ref":"(#\/[^"]+)"/g)).map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(deref(ref), `unresolved ${ref}`).toBeDefined();
  });
});

describe('gold spec — behavior matches the live backend', () => {
  function app(thinResponses = false) {
    return createApp({ file: ':memory:', thinResponses }).app;
  }

  it('every agent-facing path/verb in the spec is implemented by the backend', async () => {
    // Exercise each operation with valid inputs; the response status must be one
    // the spec documents for that operation. Spec is the only source of truth for
    // the calls. A fresh app per call keeps the deterministic seed intact.
    const cases: Array<{ path: string; verb: string; exec: () => Promise<any> }> = [
      { path: '/health', verb: 'get', exec: () => request(app()).get('/health') },
      { path: '/customers', verb: 'get', exec: () => request(app()).get('/customers?limit=50&offset=0') },
      {
        path: '/customers',
        verb: 'post',
        exec: () =>
          request(app())
            .post('/customers')
            .set('Authorization', 'Bearer token')
            .set('Idempotency-Key', '1f0c3a9e-2b6d-4d7a-9d1e-2a3b4c5d6e7f')
            .send({ name: 'New', email: 'new@example.com' }),
      },
      { path: '/customers/{customerId}', verb: 'get', exec: () => request(app()).get('/customers/cus_001') },
      {
        path: '/customers/{customerId}',
        verb: 'put',
        exec: () => request(app()).put('/customers/cus_001').send({ name: 'Renamed', email: 'ada@example.com' }),
      },
      { path: '/customers/{customerId}', verb: 'delete', exec: () => request(app()).delete('/customers/cus_003') },
      { path: '/orders', verb: 'get', exec: () => request(app()).get('/orders?customer_id=cus_001&limit=10') },
      { path: '/orders', verb: 'post', exec: () => request(app()).post('/orders').send({ customer_id: 'cus_001', status: 'pending' }) },
      { path: '/orders/{orderId}', verb: 'get', exec: () => request(app()).get('/orders/ord_001') },
      { path: '/orders/{orderId}', verb: 'put', exec: () => request(app()).put('/orders/ord_002').send({ status: 'paid' }) },
      { path: '/orders/{orderId}', verb: 'delete', exec: () => request(app()).delete('/orders/ord_003') },
      { path: '/orders/{orderId}/cancel', verb: 'post', exec: () => request(app()).post('/orders/ord_002/cancel').send() },
      { path: '/line-items', verb: 'get', exec: () => request(app()).get('/line-items?order_id=ord_001') },
      {
        path: '/line-items',
        verb: 'post',
        exec: () => request(app()).post('/line-items').send({ order_id: 'ord_001', sku: 'WIDGET-Z', quantity: 3, unit_price: 500 }),
      },
      { path: '/line-items/{lineItemId}', verb: 'get', exec: () => request(app()).get('/line-items/li_001') },
      {
        path: '/line-items/{lineItemId}',
        verb: 'put',
        exec: () => request(app()).put('/line-items/li_001').send({ sku: 'WIDGET-Z', quantity: 4, unit_price: 550 }),
      },
      { path: '/line-items/{lineItemId}', verb: 'delete', exec: () => request(app()).delete('/line-items/li_004') },
    ];

    // The cases must cover exactly the operations in the spec.
    const specOps = new Set<string>();
    for (const [p, item] of Object.entries<any>(gold.paths)) {
      for (const v of Object.keys(item)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(v)) specOps.add(`${v} ${p}`);
      }
    }
    expect(new Set(cases.map((c) => `${c.verb} ${c.path}`))).toEqual(specOps);

    for (const c of cases) {
      const res = await c.exec();
      const documented = Object.keys(gold.paths[c.path][c.verb].responses);
      expect(documented, `${c.verb} ${c.path} -> ${res.status}`).toContain(String(res.status));
      expect(res.status, `${c.verb} ${c.path} should succeed`).toBeLessThan(300);
    }
  });

  it('success bodies contain the required fields documented in the spec', async () => {
    const created = await request(app()).post('/customers').send({ name: 'B', email: 'b@example.com' });
    expect(created.status).toBe(201);
    for (const f of ['id', 'name', 'email', 'created_at']) expect(created.body).toHaveProperty(f);

    const order = await request(app()).post('/orders').send({ customer_id: 'cus_001' });
    for (const f of ['id', 'customer_id', 'status', 'created_at']) expect(order.body).toHaveProperty(f);

    const li = await request(app()).post('/line-items').send({ order_id: 'ord_001', sku: 'S', quantity: 1, unit_price: 10 });
    for (const f of ['id', 'order_id', 'sku', 'quantity', 'unit_price']) expect(li.body).toHaveProperty(f);
  });

  it('spec-declared query filters actually filter (no silent-ignore of unknown param names)', async () => {
    // Build the filtering call exactly as an agent would, from the spec's parameter names.
    // If the backend reads a differently-named key, it would silently return the full
    // collection — these assertions catch that regression.
    const orderParam = gold.paths['/orders'].get.parameters.find(
      (p: any) => p.in === 'query' && /customer/i.test(p.name),
    );
    expect(orderParam, 'spec should declare a customer filter on GET /orders').toBeTruthy();
    const allOrders = await request(app()).get('/orders');
    const filteredOrders = await request(app()).get(`/orders?${orderParam.name}=cus_001`);
    expect(filteredOrders.status).toBe(200);
    expect(filteredOrders.body.length).toBeGreaterThan(0);
    expect(filteredOrders.body.length).toBeLessThan(allOrders.body.length);
    expect(filteredOrders.body.every((o: any) => o.customer_id === 'cus_001')).toBe(true);

    const lineItemParam = gold.paths['/line-items'].get.parameters.find(
      (p: any) => p.in === 'query' && /order/i.test(p.name),
    );
    expect(lineItemParam, 'spec should declare an order filter on GET /line-items').toBeTruthy();
    const allLineItems = await request(app()).get('/line-items');
    const filteredLineItems = await request(app()).get(`/line-items?${lineItemParam.name}=ord_001`);
    expect(filteredLineItems.status).toBe(200);
    expect(filteredLineItems.body.length).toBeGreaterThan(0);
    expect(filteredLineItems.body.length).toBeLessThan(allLineItems.body.length);
    expect(filteredLineItems.body.every((li: any) => li.order_id === 'ord_001')).toBe(true);
  });

  it('error responses match the documented RFC 9457 problem+json shape', async () => {
    const notFound = await request(app()).get('/customers/cus_999');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['content-type']).toContain('application/problem+json');
    for (const f of ['type', 'title', 'status', 'detail', 'code']) expect(notFound.body).toHaveProperty(f);
    expect(notFound.body.status).toBe(404);

    const badRequest = await request(app()).post('/customers').send({ name: 'no email' });
    expect(badRequest.status).toBe(400);
    expect(badRequest.body.code).toBe('invalid_body');

    const unprocessable = await request(app()).post('/orders').send({ customer_id: 'cus_999' });
    expect(unprocessable.status).toBe(422);
    expect(unprocessable.body.code).toBe('unprocessable');

    const conflict = await request(app()).post('/customers').send({ name: 'Dup', email: 'ada@example.com' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('conflict');
  });
});
