/**
 * SQLite schema for the calibration CRUD backend.
 *
 * Domain: customers 1-* orders 1-* line_items.
 * IDs are TEXT (e.g. "cus_001", "ord_001", "li_001") so the deterministic seed
 * produces stable, human-readable identifiers every boot.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled')),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line_items (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_line_items_order ON line_items(order_id);
`;
