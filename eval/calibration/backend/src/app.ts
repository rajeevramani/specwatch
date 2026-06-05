import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { DB } from './db/index.js';
import { createDatabase } from './db/index.js';
import { customersRouter } from './routes/customers.js';
import { ordersRouter } from './routes/orders.js';
import { lineItemsRouter } from './routes/line-items.js';
import { truthRouter } from './routes/truth.js';

export interface AppOptions {
  /** SQLite file path or ':memory:'. */
  file?: string;
  /**
   * When true, write endpoints (POST/PUT) return id-only bodies; when false
   * they return the full object. Powers the response-completeness ablation
   * without touching the spec. Defaults to env THIN_RESPONSES === '1'.
   */
  thinResponses?: boolean;
}

export interface CalibApp {
  app: Express;
  db: DB;
  thinResponses: boolean;
}

/** Locals shared with route handlers. */
export interface AppLocals {
  db: DB;
  thinResponses: boolean;
}

export function createApp(opts: AppOptions = {}): CalibApp {
  const thinResponses = opts.thinResponses ?? process.env.THIN_RESPONSES === '1';
  const db = createDatabase(opts.file ?? ':memory:');

  const app = express();
  app.use(express.json());

  const locals: AppLocals = { db, thinResponses };
  app.locals.calib = locals;

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', thinResponses });
  });

  app.use('/customers', customersRouter);
  app.use('/orders', ordersRouter);
  app.use('/line-items', lineItemsRouter);
  app.use('/__truth', truthRouter);

  // 404 for unknown routes.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // JSON error handler.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'internal_error';
    res.status(500).json({ error: 'internal_error', message });
  });

  return { app, db, thinResponses };
}

export function getLocals(req: Request): AppLocals {
  return req.app.locals.calib as AppLocals;
}

/**
 * Shape a write-endpoint response body according to the THIN_RESPONSES toggle.
 * Thin → just the id; full → the complete object.
 */
export function writeBody<T extends { id: string }>(req: Request, obj: T): { id: string } | T {
  return getLocals(req).thinResponses ? { id: obj.id } : obj;
}
