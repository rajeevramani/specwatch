import type { CalibrationTask, TaskResult, TruthSnapshot, TruthOrder } from './types.js';

/**
 * Fixed multi-step calibration task set (specwatch-a7n).
 *
 * Each task is >= 3 dependent calls and is graded ONLY by a deterministic
 * assertion over `/__truth`. Assertions address state by *business identity*
 * (customer email, line-item SKU, order status) rather than by generated IDs,
 * so they are stable regardless of how many rows the seed/prior calls created
 * and identical across every spec variant.
 *
 * Markers (unique emails/SKUs) are deliberately distinct from the deterministic
 * seed data so a task's end-state is unambiguous: the row it created/changed is
 * the only one carrying its marker.
 */

const pass = (taskId: string, detail: string): TaskResult => ({ taskId, pass: true, detail });
const fail = (taskId: string, detail: string): TaskResult => ({ taskId, pass: false, detail });

/** All customers carrying a given email (should be 0 or 1; email is UNIQUE). */
function customersByEmail(truth: TruthSnapshot, email: string) {
  return truth.customers.filter((c) => c.email === email);
}

/** Orders belonging to a customer id. */
function ordersForCustomer(truth: TruthSnapshot, customerId: string): TruthOrder[] {
  return truth.orders.filter((o) => o.customer_id === customerId);
}

/** Line-items belonging to an order id. */
function lineItemsForOrder(truth: TruthSnapshot, orderId: string) {
  return truth.line_items.filter((li) => li.order_id === orderId);
}

export const TASKS: CalibrationTask[] = [
  // ---------------------------------------------------------------------------
  // Task 1: onboard a customer, open an order for them, then cancel it.
  //   create customer -> create order -> cancel order  (3 dependent calls)
  // ---------------------------------------------------------------------------
  {
    id: 't1_onboard_and_cancel',
    title: 'Onboard a customer, open an order, then cancel it',
    prompt:
      'Create a new customer named "Margaret Hamilton" with email ' +
      '"margaret.hamilton@calib.test". Open a new order for that customer, then ' +
      'cancel that order.',
    steps: [
      'POST /customers {name:"Margaret Hamilton", email:"margaret.hamilton@calib.test"}',
      'POST /orders {customer_id:<new customer id>}',
      'POST /orders/<new order id>/cancel',
    ],
    assert(truth) {
      const id = this.id;
      const matches = customersByEmail(truth, 'margaret.hamilton@calib.test');
      if (matches.length !== 1) {
        return fail(id, `expected exactly 1 customer with the marker email, found ${matches.length}`);
      }
      const customer = matches[0];
      if (customer.name !== 'Margaret Hamilton') {
        return fail(id, `customer name is "${customer.name}", expected "Margaret Hamilton"`);
      }
      const orders = ordersForCustomer(truth, customer.id);
      if (orders.length !== 1) {
        return fail(id, `expected exactly 1 order for the new customer, found ${orders.length}`);
      }
      if (orders[0].status !== 'cancelled') {
        return fail(id, `order status is "${orders[0].status}", expected "cancelled"`);
      }
      return pass(id, 'customer created and their single order is cancelled');
    },
  },

  // ---------------------------------------------------------------------------
  // Task 2: place an order with two line-items and pay it.
  //   create customer -> create order -> add line-item -> add line-item
  //     -> mark order paid  (5 dependent calls)
  // ---------------------------------------------------------------------------
  {
    id: 't2_place_order_and_pay',
    title: 'Place an order with two line-items and mark it paid',
    prompt:
      'Create a customer named "Katherine Johnson" with email ' +
      '"katherine.johnson@calib.test". Place an order for them containing two ' +
      'line-items: SKU "CALIB-ALPHA" quantity 3 at unit price 1000, and SKU ' +
      '"CALIB-BETA" quantity 1 at unit price 4999. Then mark the order as paid.',
    steps: [
      'POST /customers {name:"Katherine Johnson", email:"katherine.johnson@calib.test"}',
      'POST /orders {customer_id:<new customer id>}',
      'POST /line-items {order_id:<new order id>, sku:"CALIB-ALPHA", quantity:3, unit_price:1000}',
      'POST /line-items {order_id:<new order id>, sku:"CALIB-BETA", quantity:1, unit_price:4999}',
      'PUT /orders/<new order id> {status:"paid"}',
    ],
    assert(truth) {
      const id = this.id;
      const matches = customersByEmail(truth, 'katherine.johnson@calib.test');
      if (matches.length !== 1) {
        return fail(id, `expected exactly 1 customer with the marker email, found ${matches.length}`);
      }
      const customer = matches[0];
      const orders = ordersForCustomer(truth, customer.id);
      if (orders.length !== 1) {
        return fail(id, `expected exactly 1 order for the new customer, found ${orders.length}`);
      }
      const order = orders[0];
      if (order.status !== 'paid') {
        return fail(id, `order status is "${order.status}", expected "paid"`);
      }
      const items = lineItemsForOrder(truth, order.id);
      const alpha = items.find((li) => li.sku === 'CALIB-ALPHA');
      const beta = items.find((li) => li.sku === 'CALIB-BETA');
      if (items.length !== 2 || !alpha || !beta) {
        return fail(
          id,
          `expected exactly the 2 line-items CALIB-ALPHA + CALIB-BETA, found ${items
            .map((li) => li.sku)
            .join(',')}`,
        );
      }
      if (alpha.quantity !== 3 || alpha.unit_price !== 1000) {
        return fail(id, `CALIB-ALPHA is qty ${alpha.quantity}@${alpha.unit_price}, expected 3@1000`);
      }
      if (beta.quantity !== 1 || beta.unit_price !== 4999) {
        return fail(id, `CALIB-BETA is qty ${beta.quantity}@${beta.unit_price}, expected 1@4999`);
      }
      return pass(id, 'paid order with the two specified line-items exists');
    },
  },

  // ---------------------------------------------------------------------------
  // Task 3: fulfil an existing seeded order through its lifecycle.
  //   read order (status) -> mark paid -> mark shipped  (3 dependent calls)
  // Targets seeded ord_002 (customer cus_001), which starts 'pending'.
  // ---------------------------------------------------------------------------
  {
    id: 't3_fulfil_pending_order',
    title: 'Drive the pending order for Ada Lovelace to shipped',
    prompt:
      'Ada Lovelace (email "ada@example.com") has an order that is currently in ' +
      '"pending" status. Find that pending order, mark it as paid, and then mark ' +
      'it as shipped.',
    steps: [
      'GET /customers (or filter) to resolve ada@example.com -> customer id',
      'GET /orders?customer_id=<id> and pick the order whose status is "pending"',
      'PUT /orders/<pending order id> {status:"paid"}',
      'PUT /orders/<that order id> {status:"shipped"}',
    ],
    assert(truth) {
      const id = this.id;
      const matches = customersByEmail(truth, 'ada@example.com');
      if (matches.length !== 1) {
        return fail(id, `expected the seeded ada@example.com customer, found ${matches.length}`);
      }
      const ada = matches[0];
      const orders = ordersForCustomer(truth, ada.id);
      // Ada starts with one 'paid' (ord_001) and one 'pending' (ord_002).
      const pendingCount = orders.filter((o) => o.status === 'pending').length;
      const shippedCount = orders.filter((o) => o.status === 'shipped').length;
      if (pendingCount !== 0) {
        return fail(id, `Ada still has ${pendingCount} pending order(s); the pending one was not advanced`);
      }
      if (shippedCount !== 1) {
        return fail(id, `expected exactly 1 of Ada's orders to be shipped, found ${shippedCount}`);
      }
      return pass(id, "Ada's formerly-pending order is now shipped and none remain pending");
    },
  },

  // ---------------------------------------------------------------------------
  // Task 4: correct a line-item on an existing order (read -> update -> verify).
  //   list line-items for order -> update the matching line-item  (>= 3 calls
  //   including the resolve of the order). Targets seeded ord_001 / li_001.
  // ---------------------------------------------------------------------------
  {
    id: 't4_correct_line_item_quantity',
    title: 'Correct the quantity of a line-item on a seeded order',
    prompt:
      'Order "ord_001" contains a line-item with SKU "WIDGET-A". The quantity is ' +
      'wrong: update that line-item so its quantity is 7 (leave its unit price ' +
      'unchanged at 1500).',
    steps: [
      'GET /line-items?order_id=ord_001 to find the WIDGET-A line-item id',
      'GET /line-items/<id> to read its current sku/unit_price',
      'PUT /line-items/<id> {sku:"WIDGET-A", quantity:7, unit_price:1500}',
    ],
    assert(truth) {
      const id = this.id;
      const widgetA = truth.line_items.filter(
        (li) => li.order_id === 'ord_001' && li.sku === 'WIDGET-A',
      );
      if (widgetA.length !== 1) {
        return fail(id, `expected exactly 1 WIDGET-A line-item on ord_001, found ${widgetA.length}`);
      }
      const li = widgetA[0];
      if (li.quantity !== 7) {
        return fail(id, `WIDGET-A quantity is ${li.quantity}, expected 7`);
      }
      if (li.unit_price !== 1500) {
        return fail(id, `WIDGET-A unit_price is ${li.unit_price}, expected it left at 1500`);
      }
      return pass(id, 'WIDGET-A on ord_001 has quantity 7 with unit price preserved');
    },
  },

  // ---------------------------------------------------------------------------
  // Task 5: onboard two customers, rename one and delete the other.
  //   create A -> create B -> rename A -> delete B  (4 dependent calls)
  // Ends with a POSITIVE, non-trivial end-state (renamed A present, B's email
  // absent) so a no-op agent cannot pass: A's marker email must exist with the
  // renamed value, which only the full sequence can produce.
  // ---------------------------------------------------------------------------
  {
    id: 't5_onboard_rename_offboard',
    title: 'Onboard two customers, rename one and off-board the other',
    prompt:
      'Create two customers: "Temp Keeper" with email "keep.user@calib.test" and ' +
      '"Temp Reject" with email "reject.user@calib.test". Then rename "Temp Keeper" ' +
      'to "Permanent Keeper" (keep its email). Finally, delete the "Temp Reject" ' +
      'customer entirely.',
    steps: [
      'POST /customers {name:"Temp Keeper", email:"keep.user@calib.test"}',
      'POST /customers {name:"Temp Reject", email:"reject.user@calib.test"}',
      'PUT /customers/<keeper id> {name:"Permanent Keeper", email:"keep.user@calib.test"}',
      'DELETE /customers/<reject id>',
    ],
    assert(truth) {
      const id = this.id;
      const keepers = customersByEmail(truth, 'keep.user@calib.test');
      if (keepers.length !== 1) {
        return fail(id, `expected exactly 1 keeper customer, found ${keepers.length}`);
      }
      if (keepers[0].name !== 'Permanent Keeper') {
        return fail(id, `keeper name is "${keepers[0].name}", expected "Permanent Keeper"`);
      }
      const rejects = customersByEmail(truth, 'reject.user@calib.test');
      if (rejects.length !== 0) {
        return fail(id, `expected the reject customer to be deleted, but ${rejects.length} remain(s)`);
      }
      return pass(id, 'keeper customer renamed and present; reject customer removed');
    },
  },
];

/** Look up a task by id; throws if unknown. */
export function getTask(taskId: string): CalibrationTask {
  const t = TASKS.find((task) => task.id === taskId);
  if (!t) throw new Error(`unknown calibration task: ${taskId}`);
  return t;
}
