# Calibration specs

Hand-authored OpenAPI documents for the JAIRF spec-ablation experiment.

## `gold.yaml`

The **gold** baseline (task specwatch-tey): a high-quality OpenAPI 3.1 spec for
the calibration backend (`../backend`) with the phase-1 signal families good —

- full operation / parameter / schema descriptions
- clean, unique, camelCase `operationId`s
- response examples on every operation (note: **request** examples are partial —
  `request_examples: 35` vs `response_examples: 100`; the `no-examples` variant is
  therefore primarily a response-example ablation)
- RFC 9457 (`application/problem+json`) error-response schemas
- complete write-response bodies (the full created/updated resource)

It maps 1:1 to the backend's agent-facing surface (17 operations) and matches
real backend behavior: the backend emits the same problem+json error shape, and
write endpoints return the full resource. The test-only `/__truth` readback
endpoints are intentionally excluded (agents never see them).

### Verify

```sh
cd ../backend

# 1. Score it (asserts JAIRF overall >= 80, all phase-1 signals pass).
npm run score:gold

# 2. Validate OpenAPI 3.1 (redocly lint -> 0 errors; needs network for npx).
npm run lint:spec

# 3. Full acceptance test — score >= 80, structural validity, and the spec's
#    every path/verb exercised against the live backend with matching behavior.
npx vitest run test/gold-spec.test.ts
```

The scoring + behavior-match assertions run offline in vitest. `lint:spec`
fetches `@redocly/cli` via npx and needs network access; the vitest suite
includes an equivalent structural-validity check that runs without it.
