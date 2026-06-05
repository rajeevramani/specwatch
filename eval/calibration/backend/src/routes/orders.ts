import { Router } from 'express';
import { getLocals, writeBody } from '../app.js';
import { nextId } from '../ids.js';
import { sendProblem } from '../errors.js';

export const ordersRouter = Router();

const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

interface Order {
  id: string;
  customer_id: string;
  status: Status;
  created_at: string;
}

function getOrder(req: import('express').Request, id: string): Order | undefined {
  return getLocals(req).db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as
    | Order
    | undefined;
}

// List (optional ?customer_id filter)
ordersRouter.get('/', (req, res) => {
  const db = getLocals(req).db;
  const customerId = req.query.customer_id;
  if (typeof customerId === 'string') {
    return res.json(
      db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id').all(customerId),
    );
  }
  res.json(db.prepare('SELECT * FROM orders ORDER BY id').all());
});

// Read
ordersRouter.get('/:id', (req, res) => {
  const o = getOrder(req, req.params.id);
  if (!o) return sendProblem(res, 404, 'not_found', 'No order exists with the supplied identifier.');
  res.json(o);
});

// Create
ordersRouter.post('/', (req, res) => {
  const { customer_id, status } = req.body ?? {};
  if (typeof customer_id !== 'string') {
    return sendProblem(res, 400, 'invalid_body', 'customer_id is required');
  }
  const st: Status = status ?? 'pending';
  if (!STATUSES.includes(st)) {
    return sendProblem(res, 400, 'invalid_body', `status must be one of ${STATUSES.join(', ')}`);
  }
  const db = getLocals(req).db;
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
  if (!customer) {
    return sendProblem(res, 422, 'unprocessable', 'customer_id does not exist');
  }
  const id = nextId(db, 'orders', 'ord');
  const created_at = new Date().toISOString();
  db.prepare('INSERT INTO orders (id, customer_id, status, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    customer_id,
    st,
    created_at,
  );
  const created: Order = { id, customer_id, status: st, created_at };
  res.status(201).json(writeBody(req, created));
});

// Update status (PUT full mutable replace)
ordersRouter.put('/:id', (req, res) => {
  const existing = getOrder(req, req.params.id);
  if (!existing) return sendProblem(res, 404, 'not_found', 'No order exists with the supplied identifier.');
  const { status } = req.body ?? {};
  if (!STATUSES.includes(status)) {
    return sendProblem(res, 400, 'invalid_body', `status must be one of ${STATUSES.join(', ')}`);
  }
  const db = getLocals(req).db;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  const updated: Order = { ...existing, status };
  res.json(writeBody(req, updated));
});

// Cancel (convenience verb modeled as a sub-resource action)
ordersRouter.post('/:id/cancel', (req, res) => {
  const existing = getOrder(req, req.params.id);
  if (!existing) return sendProblem(res, 404, 'not_found', 'No order exists with the supplied identifier.');
  const db = getLocals(req).db;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', req.params.id);
  const updated: Order = { ...existing, status: 'cancelled' };
  res.json(writeBody(req, updated));
});

// Delete
ordersRouter.delete('/:id', (req, res) => {
  const db = getLocals(req).db;
  const info = db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return sendProblem(res, 404, 'not_found', 'No order exists with the supplied identifier.');
  res.status(204).end();
});
