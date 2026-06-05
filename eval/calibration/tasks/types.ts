/**
 * Shared types for the calibration task set.
 *
 * A *task* is a fixed, multi-step agent job run against the calibration backend.
 * Its pass/fail is decided ONLY by a deterministic assertion over the backend's
 * ground-truth state (read via `/__truth`) — never by the agent's self-report.
 *
 * The same task set runs unchanged against every spec variant: the prompt and
 * the assertion are spec-independent (they reference business identities such as
 * a customer email or an order's line-item SKU, not generated IDs or wording from
 * any particular spec). Only the spec the agent *sees* changes between variants.
 */

/** One customer row as exposed by `/__truth/customers`. */
export interface TruthCustomer {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

/** One order row as exposed by `/__truth/orders`. */
export interface TruthOrder {
  id: string;
  customer_id: string;
  status: 'pending' | 'paid' | 'shipped' | 'cancelled';
  created_at: string;
}

/** One line-item row as exposed by `/__truth/line-items`. */
export interface TruthLineItem {
  id: string;
  order_id: string;
  sku: string;
  quantity: number;
  unit_price: number;
}

/** Full ground-truth snapshot, as returned by `GET /__truth`. */
export interface TruthSnapshot {
  customers: TruthCustomer[];
  orders: TruthOrder[];
  line_items: TruthLineItem[];
}

/** Result of evaluating a single task's assertion against ground truth. */
export interface TaskResult {
  taskId: string;
  pass: boolean;
  /** Human-readable explanation of why it passed/failed (for diagnostics only). */
  detail: string;
}

/**
 * A single calibration task.
 *
 * `steps` documents the intended dependent calls for humans and powers the
 * happy-path test; the agent runner does NOT replay `steps` — it is handed only
 * `prompt` + the spec-derived tools and must work the calls out itself. `assert`
 * is the sole arbiter of success and reads ground truth exclusively.
 */
export interface CalibrationTask {
  /** Stable identifier, e.g. `t1_onboard_and_cancel`. */
  id: string;
  /** Short human title. */
  title: string;
  /**
   * Natural-language instruction handed to the agent. Spec-independent: refers
   * to business intent (emails, SKUs, statuses), never to operationIds or any
   * wording unique to a variant.
   */
  prompt: string;
  /**
   * The intended happy-path sequence of dependent backend calls (>= 3). Used by
   * the happy-path test and as human documentation; never used to grade a run.
   */
  steps: string[];
  /**
   * Deterministic pass/fail assertion over ground truth. Pure function of the
   * snapshot — same snapshot always yields the same verdict.
   */
  assert(truth: TruthSnapshot): TaskResult;
}
