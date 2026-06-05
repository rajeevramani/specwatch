import { Router } from 'express';
import { getLocals, writeBody } from '../app.js';
import { nextId } from '../ids.js';

export const customersRouter = Router();

interface Customer {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

function getCustomer(req: import('express').Request, id: string): Customer | undefined {
  return getLocals(req).db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as
    | Customer
    | undefined;
}

// List
customersRouter.get('/', (req, res) => {
  const rows = getLocals(req).db.prepare('SELECT * FROM customers ORDER BY id').all();
  res.json(rows);
});

// Read
customersRouter.get('/:id', (req, res) => {
  const c = getCustomer(req, req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(c);
});

// Create
customersRouter.post('/', (req, res) => {
  const { name, email } = req.body ?? {};
  if (typeof name !== 'string' || typeof email !== 'string') {
    return res.status(400).json({ error: 'invalid_body', message: 'name and email are required' });
  }
  const db = getLocals(req).db;
  const id = nextId(db, 'customers', 'cus');
  const created_at = new Date().toISOString();
  try {
    db.prepare('INSERT INTO customers (id, name, email, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      email,
      created_at,
    );
  } catch (e) {
    return res.status(409).json({ error: 'conflict', message: (e as Error).message });
  }
  const created: Customer = { id, name, email, created_at };
  res.status(201).json(writeBody(req, created));
});

// Update (full replace of mutable fields)
customersRouter.put('/:id', (req, res) => {
  const existing = getCustomer(req, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { name, email } = req.body ?? {};
  if (typeof name !== 'string' || typeof email !== 'string') {
    return res.status(400).json({ error: 'invalid_body', message: 'name and email are required' });
  }
  const db = getLocals(req).db;
  try {
    db.prepare('UPDATE customers SET name = ?, email = ? WHERE id = ?').run(
      name,
      email,
      req.params.id,
    );
  } catch (e) {
    return res.status(409).json({ error: 'conflict', message: (e as Error).message });
  }
  const updated: Customer = { ...existing, name, email };
  res.json(writeBody(req, updated));
});

// Delete
customersRouter.delete('/:id', (req, res) => {
  const db = getLocals(req).db;
  const info = db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});
