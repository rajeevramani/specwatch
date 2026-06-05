import { Router } from 'express';
import { getLocals, writeBody } from '../app.js';
import { nextId } from '../ids.js';

// Line-items are nested under an order: /orders/:orderId/line-items as well as
// a flat /line-items/:id for direct read/update/delete.
export const lineItemsRouter = Router();

interface LineItem {
  id: string;
  order_id: string;
  sku: string;
  quantity: number;
  unit_price: number;
}

function getLineItem(req: import('express').Request, id: string): LineItem | undefined {
  return getLocals(req).db.prepare('SELECT * FROM line_items WHERE id = ?').get(id) as
    | LineItem
    | undefined;
}

// List (optional ?order_id filter)
lineItemsRouter.get('/', (req, res) => {
  const db = getLocals(req).db;
  const orderId = req.query.order_id;
  if (typeof orderId === 'string') {
    return res.json(
      db.prepare('SELECT * FROM line_items WHERE order_id = ? ORDER BY id').all(orderId),
    );
  }
  res.json(db.prepare('SELECT * FROM line_items ORDER BY id').all());
});

// Read
lineItemsRouter.get('/:id', (req, res) => {
  const li = getLineItem(req, req.params.id);
  if (!li) return res.status(404).json({ error: 'not_found' });
  res.json(li);
});

// Create
lineItemsRouter.post('/', (req, res) => {
  const { order_id, sku, quantity, unit_price } = req.body ?? {};
  if (
    typeof order_id !== 'string' ||
    typeof sku !== 'string' ||
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    !Number.isInteger(unit_price) ||
    unit_price < 0
  ) {
    return res.status(400).json({
      error: 'invalid_body',
      message: 'order_id, sku, positive integer quantity and non-negative integer unit_price are required',
    });
  }
  const db = getLocals(req).db;
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(order_id);
  if (!order) {
    return res.status(422).json({ error: 'unprocessable', message: 'order_id does not exist' });
  }
  const id = nextId(db, 'line_items', 'li');
  db.prepare(
    'INSERT INTO line_items (id, order_id, sku, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
  ).run(id, order_id, sku, quantity, unit_price);
  const created: LineItem = { id, order_id, sku, quantity, unit_price };
  res.status(201).json(writeBody(req, created));
});

// Update
lineItemsRouter.put('/:id', (req, res) => {
  const existing = getLineItem(req, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { sku, quantity, unit_price } = req.body ?? {};
  if (
    typeof sku !== 'string' ||
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    !Number.isInteger(unit_price) ||
    unit_price < 0
  ) {
    return res.status(400).json({
      error: 'invalid_body',
      message: 'sku, positive integer quantity and non-negative integer unit_price are required',
    });
  }
  const db = getLocals(req).db;
  db.prepare('UPDATE line_items SET sku = ?, quantity = ?, unit_price = ? WHERE id = ?').run(
    sku,
    quantity,
    unit_price,
    req.params.id,
  );
  const updated: LineItem = { ...existing, sku, quantity, unit_price };
  res.json(writeBody(req, updated));
});

// Delete
lineItemsRouter.delete('/:id', (req, res) => {
  const db = getLocals(req).db;
  const info = db.prepare('DELETE FROM line_items WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});
