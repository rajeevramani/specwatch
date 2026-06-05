import { Router } from 'express';
import { getLocals } from '../app.js';

/**
 * TEST-ONLY readback endpoints. These expose raw DB state so the task runner can
 * make end-state (DB-diff) assertions without going through the public API.
 * Not part of the gold OpenAPI spec; agents never see these.
 */
export const truthRouter = Router();

truthRouter.get('/', (req, res) => {
  const db = getLocals(req).db;
  res.json({
    customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
    orders: db.prepare('SELECT * FROM orders ORDER BY id').all(),
    line_items: db.prepare('SELECT * FROM line_items ORDER BY id').all(),
  });
});

truthRouter.get('/customers', (req, res) => {
  res.json(getLocals(req).db.prepare('SELECT * FROM customers ORDER BY id').all());
});

truthRouter.get('/orders', (req, res) => {
  res.json(getLocals(req).db.prepare('SELECT * FROM orders ORDER BY id').all());
});

truthRouter.get('/line-items', (req, res) => {
  res.json(getLocals(req).db.prepare('SELECT * FROM line_items ORDER BY id').all());
});

// Counts — handy for quick assertions.
truthRouter.get('/counts', (req, res) => {
  const db = getLocals(req).db;
  const count = (t: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  res.json({
    customers: count('customers'),
    orders: count('orders'),
    line_items: count('line_items'),
  });
});
