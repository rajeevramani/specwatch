/**
 * Deterministic mock agent plans for the a7n task set (specwatch-ajn).
 *
 * Each plan is the scripted sequence of tool calls a *competent* agent would
 * make to satisfy one task, keyed by that task's exact prompt text. The mock
 * threads server-assigned ids (created customer/order ids) from earlier results
 * into later calls via the `ctx` callback — exactly like a real agent, but
 * deterministically. These plans target the GOLD spec's tool names; on the gold
 * variant every task therefore SUCCEEDS, proving the full pipeline end-to-end
 * with no paid model calls.
 *
 * Tool names here are the gold spec's operationIds (createCustomer, createOrder,
 * …) which `specToTools` emits verbatim for the gold variant.
 */
import { getTask } from '../tasks/index.js';
import type { MockContext, MockPlan } from './llm.js';

/** Pull the JSON body of the Nth call to a given tool from the mock context. */
function outputOf(ctx: MockContext, toolName: string, occurrence = 0): any {
  let seen = 0;
  for (const r of ctx.results) {
    if (r.name === toolName) {
      if (seen === occurrence) return r.output;
      seen += 1;
    }
  }
  return undefined;
}

const t1 = getTask('t1_onboard_and_cancel');
const t2 = getTask('t2_place_order_and_pay');
const t3 = getTask('t3_fulfil_pending_order');
const t4 = getTask('t4_correct_line_item_quantity');
const t5 = getTask('t5_onboard_rename_offboard');

/**
 * The gold-spec plans. Keyed by prompt text so {@link MockLlmClient} can serve
 * the whole set. Each step's tool calls are executed together, then the model
 * "sees" the results before the next step.
 */
export const GOLD_MOCK_PLANS: Record<string, MockPlan> = {
  // t1: create customer -> create order -> cancel order.
  [t1.prompt]: [
    {
      type: 'tools',
      calls: [
        {
          name: 'createCustomer',
          input: { name: 'Margaret Hamilton', email: 'margaret.hamilton@calib.test' },
        },
      ],
    },
    {
      type: 'tools',
      calls: [
        { name: 'createOrder', input: (ctx) => ({ customer_id: outputOf(ctx, 'createCustomer')?.id }) },
      ],
    },
    {
      type: 'tools',
      calls: [{ name: 'cancelOrder', input: (ctx) => ({ orderId: outputOf(ctx, 'createOrder')?.id }) }],
    },
    { type: 'end', text: 'Created Margaret Hamilton, opened an order, and cancelled it.' },
  ],

  // t2: create customer -> create order -> add two line items -> mark paid.
  [t2.prompt]: [
    {
      type: 'tools',
      calls: [
        {
          name: 'createCustomer',
          input: { name: 'Katherine Johnson', email: 'katherine.johnson@calib.test' },
        },
      ],
    },
    {
      type: 'tools',
      calls: [
        { name: 'createOrder', input: (ctx) => ({ customer_id: outputOf(ctx, 'createCustomer')?.id }) },
      ],
    },
    {
      type: 'tools',
      calls: [
        {
          name: 'createLineItem',
          input: (ctx) => ({
            order_id: outputOf(ctx, 'createOrder')?.id,
            sku: 'CALIB-ALPHA',
            quantity: 3,
            unit_price: 1000,
          }),
        },
        {
          name: 'createLineItem',
          input: (ctx) => ({
            order_id: outputOf(ctx, 'createOrder')?.id,
            sku: 'CALIB-BETA',
            quantity: 1,
            unit_price: 4999,
          }),
        },
      ],
    },
    {
      type: 'tools',
      calls: [
        {
          name: 'updateOrder',
          input: (ctx) => ({ orderId: outputOf(ctx, 'createOrder')?.id, status: 'paid' }),
        },
      ],
    },
    { type: 'end', text: 'Placed the order with both line items and marked it paid.' },
  ],

  // t3: list Ada's orders -> find pending -> mark paid -> mark shipped.
  [t3.prompt]: [
    { type: 'tools', calls: [{ name: 'listOrders', input: { customer_id: 'cus_001' } }] },
    {
      type: 'tools',
      calls: [
        {
          name: 'updateOrder',
          input: (ctx) => {
            const orders: any[] = outputOf(ctx, 'listOrders') ?? [];
            const pending = orders.find((o) => o.status === 'pending');
            return { orderId: pending?.id, status: 'paid' };
          },
        },
      ],
    },
    {
      type: 'tools',
      calls: [
        {
          name: 'updateOrder',
          input: (ctx) => {
            const orders: any[] = outputOf(ctx, 'listOrders') ?? [];
            const pending = orders.find((o) => o.status === 'pending');
            return { orderId: pending?.id, status: 'shipped' };
          },
        },
      ],
    },
    { type: 'end', text: "Advanced Ada's pending order through paid to shipped." },
  ],

  // t4: list line items for ord_001 -> update WIDGET-A quantity to 7.
  [t4.prompt]: [
    { type: 'tools', calls: [{ name: 'listLineItems', input: { order_id: 'ord_001' } }] },
    {
      type: 'tools',
      calls: [
        {
          name: 'updateLineItem',
          input: (ctx) => {
            const items: any[] = outputOf(ctx, 'listLineItems') ?? [];
            const widgetA = items.find((li) => li.sku === 'WIDGET-A');
            return { lineItemId: widgetA?.id, sku: 'WIDGET-A', quantity: 7, unit_price: 1500 };
          },
        },
      ],
    },
    { type: 'end', text: 'Corrected WIDGET-A on ord_001 to quantity 7.' },
  ],

  // t5: create keeper -> create reject -> rename keeper -> delete reject.
  [t5.prompt]: [
    {
      type: 'tools',
      calls: [
        { name: 'createCustomer', input: { name: 'Temp Keeper', email: 'keep.user@calib.test' } },
        { name: 'createCustomer', input: { name: 'Temp Reject', email: 'reject.user@calib.test' } },
      ],
    },
    {
      type: 'tools',
      calls: [
        {
          name: 'updateCustomer',
          input: (ctx) => ({
            customerId: outputOf(ctx, 'createCustomer', 0)?.id,
            name: 'Permanent Keeper',
            email: 'keep.user@calib.test',
          }),
        },
      ],
    },
    {
      type: 'tools',
      calls: [
        {
          name: 'deleteCustomer',
          input: (ctx) => ({ customerId: outputOf(ctx, 'createCustomer', 1)?.id }),
        },
      ],
    },
    { type: 'end', text: 'Renamed the keeper and removed the reject customer.' },
  ],
};
