---
name: generate-types
description: "Generate TypeScript types and a typed client from a Specwatch-captured OpenAPI spec. Use when you want to consume a previously-learned API in TypeScript with full type safety. Not for generic OpenAPI files - use openapi-typescript for that."
---

# Generate TypeScript Types from Learned Spec

Target session: $ARGUMENTS (session name, or blank for latest)

## Step 1: Export the spec

```bash
EXPORT_FILE="${TMPDIR:-/tmp}/specwatch-export.yaml"
"$CLAUDE_PLUGIN_ROOT/bin/specwatch-exec" export "$ARGUMENTS" --output "$EXPORT_FILE" 2>&1
```

If export fails, check if aggregation is needed:
```bash
npx specwatch sessions list 2>&1
```

## Step 2: Read the spec

Read the export file using the Read tool (path printed in step 1, typically `/tmp/specwatch-export.yaml`).

## Step 3: Generate types

From the OpenAPI spec, generate two files:

**a) `api-types.ts`** - TypeScript interfaces for every schema in `components/schemas`:
- Use `interface` for object types, `type` for unions and primitives
- Map OpenAPI `integer`/`number` to `number`, `boolean` to `boolean`, `string` to `string`
- Emit string enums when the spec has `enum` constraints
- Use `?` for optional fields (not in `required` array)
- Add JSDoc comments for descriptions when present
- Export every type

**b) `api-client.ts`** - A typed fetch-based client:
- One function per operation (named after `operationId` if present, else `<method><PathPascalCase>`)
- Accept typed request body and query params based on the spec
- Return a typed Promise of the response schema
- Include the base URL as a constructor parameter
- Handle auth: if the spec has `bearerAuth`, accept an optional `token` parameter

Write these files to the current working directory.

## Step 4: Summary

Report:
- Number of types generated
- Number of client functions generated
- Any endpoints that lacked enough schema info (low confidence or missing response schema)
- A 3-line usage example showing how to use the generated client
