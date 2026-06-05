# Calibration task set (specwatch-a7n)

Fixed, multi-step agent jobs run against the calibration backend. The **same set
runs unchanged against every spec variant** — only the spec the agent *sees*
changes. Each task is graded by a **deterministic ground-truth assertion** read
from the backend's `/__truth` endpoint, never by the agent's self-report.

## Files

- `types.ts`   — `CalibrationTask`, `TruthSnapshot`, `TaskResult` shapes.
- `tasks.ts`   — `TASKS`: 5 tasks, each ≥ 3 dependent backend calls, each with a
  pure `assert(truth)` verdict.
- `check.ts`   — runnable checker: `checkTasks(truth)`, `fetchTruth(url)`,
  `checkTasksAgainst(url)`, plus a CLI.
- `index.ts`   — barrel export.

## The tasks

| id | shape (dependent calls) |
|---|---|
| `t1_onboard_and_cancel`         | create customer → create order → cancel order |
| `t2_place_order_and_pay`        | create customer → create order → +2 line-items → mark paid |
| `t3_fulfil_pending_order`       | resolve customer → find pending order → mark paid → mark shipped |
| `t4_correct_line_item_quantity` | list line-items → read item → update quantity |
| `t5_onboard_rename_offboard`    | create A → create B → rename A → delete B |

## Why assertions are spec-independent and deterministic

Assertions address state by **business identity** (a marker customer email, a
line-item SKU, an order status) — never by generated IDs or by wording from any
particular spec. Marker emails/SKUs (`*.calib.test`, `CALIB-*`) are disjoint from
the deterministic seed, so the row a task created/changed is unambiguous. Every
task's end-state is **positive and non-trivial**: a no-op agent fails (proven by
the "fresh backend" tests in `backend/test/tasks.test.ts`).

## Running the checker

Against a running backend (defaults to `http://localhost:8787`):

```sh
cd eval/calibration/backend
npm run check:tasks -- http://localhost:8799
```

Exit code `0` iff every task passes, `1` otherwise. The happy-path test that
drives each task and asserts its `/__truth` verdict lives in
`backend/test/tasks.test.ts`.
