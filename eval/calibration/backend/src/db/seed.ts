import type Database from 'better-sqlite3';

/**
 * Deterministic seed data. Every boot produces byte-identical rows so
 * end-state assertions in the task set are stable.
 *
 * A fixed timestamp is used (not Date.now()) to keep the seed reproducible.
 */
const SEED_TS = '2026-01-01T00:00:00.000Z';

const CUSTOMERS = [
  { id: 'cus_001', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 'cus_002', name: 'Alan Turing', email: 'alan@example.com' },
  { id: 'cus_003', name: 'Grace Hopper', email: 'grace@example.com' },
];

const ORDERS = [
  { id: 'ord_001', customer_id: 'cus_001', status: 'paid' },
  { id: 'ord_002', customer_id: 'cus_001', status: 'pending' },
  { id: 'ord_003', customer_id: 'cus_002', status: 'shipped' },
];

const LINE_ITEMS = [
  { id: 'li_001', order_id: 'ord_001', sku: 'WIDGET-A', quantity: 2, unit_price: 1500 },
  { id: 'li_002', order_id: 'ord_001', sku: 'WIDGET-B', quantity: 1, unit_price: 3000 },
  { id: 'li_003', order_id: 'ord_002', sku: 'WIDGET-A', quantity: 5, unit_price: 1500 },
  { id: 'li_004', order_id: 'ord_003', sku: 'GADGET-C', quantity: 1, unit_price: 9900 },
];

export function seed(db: Database.Database): void {
  const insCustomer = db.prepare(
    'INSERT INTO customers (id, name, email, created_at) VALUES (?, ?, ?, ?)',
  );
  const insOrder = db.prepare(
    'INSERT INTO orders (id, customer_id, status, created_at) VALUES (?, ?, ?, ?)',
  );
  const insLineItem = db.prepare(
    'INSERT INTO line_items (id, order_id, sku, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
  );

  const tx = db.transaction(() => {
    for (const c of CUSTOMERS) insCustomer.run(c.id, c.name, c.email, SEED_TS);
    for (const o of ORDERS) insOrder.run(o.id, o.customer_id, o.status, SEED_TS);
    for (const li of LINE_ITEMS) insLineItem.run(li.id, li.order_id, li.sku, li.quantity, li.unit_price);
  });
  tx();
}

export const SEED = { CUSTOMERS, ORDERS, LINE_ITEMS, SEED_TS };
