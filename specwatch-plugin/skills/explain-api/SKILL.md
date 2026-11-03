---
name: explain-api
description: "Export and explain a Specwatch-captured API - its purpose, resource model, authentication, endpoints, and key patterns. Use when onboarding to an API you have already learned with Specwatch, or documenting a recorded session."
---

# Explain API

Session: $ARGUMENTS (blank = latest completed session)

## Step 1: Export the spec

```bash
EXPORT_FILE="${TMPDIR:-/tmp}/specwatch-export.yaml"
"$CLAUDE_PLUGIN_ROOT/bin/specwatch-exec" export "$ARGUMENTS" --output "$EXPORT_FILE" 2>&1
```

Also get session metadata:
```bash
npx specwatch sessions list 2>&1
"$CLAUDE_PLUGIN_ROOT/bin/specwatch-exec" snapshots "$ARGUMENTS" 2>&1
```

## Step 2: Read the spec

Read the export file using the Read tool (path printed in step 1, typically `/tmp/specwatch-export.yaml`).

## Step 3: Explain the API

Write a comprehensive explanation covering:

**Overview**
- What this API does (inferred from path structure and resource names)
- Base URL and version

**Authentication**
- What auth scheme is used (Bearer token, API key, Basic, none)
- Where credentials go (header name, query param name)

**Resource Model**
- The main resources (top-level path segments like `/users`, `/accounts`)
- How resources relate to each other (e.g., `/users/{userId}/accounts` suggests accounts belong to users)
- A simple ASCII diagram of the resource hierarchy

**Endpoints by Resource**
For each resource group, list the operations as a table:
| Method | Path | Purpose | Request Body | Response |

**Key Patterns**
- Pagination (look for `page`, `limit`, `offset`, `cursor` query params)
- Error format (look at 4xx/5xx response schemas)
- ID format (UUID, integer, string slug)
- Naming conventions (camelCase, snake_case, kebab-case)

**Confidence Assessment**
- Which endpoints have high confidence (>0.8) vs low confidence (<0.5)
- Suggest capturing more traffic for low-confidence endpoints
