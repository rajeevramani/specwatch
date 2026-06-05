import type { DB } from './db/index.js';

/**
 * Generate the next id for a resource, e.g. nextId(db, 'customers', 'cus').
 *
 * Scans existing rows whose id matches `<prefix>_NNN` and returns the next
 * zero-padded value. Because the seed is deterministic and IDs are allocated in
 * request order, a fixed task script yields fixed IDs.
 */
export function nextId(db: DB, table: 'customers' | 'orders' | 'line_items', prefix: string): string {
  const rows = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  let max = 0;
  for (const { id } of rows) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}_${String(max + 1).padStart(3, '0')}`;
}
