# Calibration CRUD backend

Thin REST CRUD backend for the JAIRF calibration harness. Domain: **customers → orders →
line-items**, backed by SQLite (better-sqlite3) with a **deterministic seed** (identical data
every boot). Conventional REST: resource paths, standard verbs, standard status codes.

## Boot

```bash
npm install        # once
npm start          # http://localhost:8787  (in-memory DB)
```

Environment:

| var             | default     | meaning                                                            |
| --------------- | ----------- | ------------------------------------------------------------------ |
| `PORT`          | `8787`      | listen port                                                        |
| `DB_FILE`       | `:memory:`  | SQLite path; file-backed DBs are reset to seed state on each boot  |
| `THIN_RESPONSES`| `0`         | `1` → write endpoints return `{ id }` only; `0` → full object      |

## Endpoints

- `GET/POST /customers`, `GET/PUT/DELETE /customers/:id`
- `GET/POST /orders`, `GET/PUT/DELETE /orders/:id`, `POST /orders/:id/cancel`, `?customer_id=`
- `GET/POST /line-items`, `GET/PUT/DELETE /line-items/:id`, `?order_id=`
- `GET /health`

### Test-only readback (`/__truth/*`)

Not part of the gold spec; used for end-state assertions.

- `GET /__truth` — full DB state `{ customers, orders, line_items }`
- `GET /__truth/{customers|orders|line-items}`
- `GET /__truth/counts`

## THIN_RESPONSES ablation

The `THIN_RESPONSES` toggle drives the response-completeness ablation **from backend behavior**,
not the spec: with `THIN_RESPONSES=1` every write (POST/PUT, order cancel) returns only `{ id }`,
forcing the agent to re-fetch. The spec is unchanged across variants.

## Tests

```bash
npm test           # vitest: CRUD + /__truth + deterministic seed + toggle
```
