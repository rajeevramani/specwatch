/* eslint-disable */
/**
 * ============================================================================
 * VENDORED FILE — DO NOT EDIT BY HAND
 * ============================================================================
 *
 * Source of truth:
 *   ../agent-ready-score/src/lib/scoring.ts
 *
 * This is a byte-for-byte vendored copy of AgentReady's JAIRF scorer, kept
 * here so the calibration harness (and specwatch) can import scoreSpec /
 * extractRuntimeSignals / public types from a single package.
 *
 * To re-sync after changing the source of truth, run from the specwatch repo
 * root:
 *
 *   node eval/calibration/scripts/sync-scoring.mjs
 *
 * The sync script copies the source verbatim (re-adding this banner) and the
 * package test asserts the result still scores a sample spec — a divergence
 * tripwire. See PROVENANCE.md for the full divergence-risk discussion.
 * ============================================================================
 */
import yaml from "js-yaml";

export type Severity = "pass" | "warn" | "fail";

export interface Finding {
  severity: Severity;
  message: string;
  location?: string;
}

export interface SignalResult {
  id: string;
  name: string;
  score: number; // 0..100
  confidence?: "heuristic" | "llm-assisted" | "observed";
}

/**
 * Per-operation runtime evidence emitted by Specwatch as an `x-specwatch-agent`
 * OpenAPI extension (`specwatch export --format openapi`). Observed from real
 * traffic, so it grounds signals a static spec read can only guess at.
 */
export interface SpecwatchAgentExt {
  responseCompleteness?: number; // 0..1 — write-response fields / matching read-response fields
  missingFields?: string[];
  verificationLoopDetected?: boolean;
  verificationLoopCount?: number;
  commonNextSteps?: string[];
}

/** Aggregated runtime signals derived from observed traffic. */
export interface RuntimeSignals {
  present: boolean;
  /** keyed by "METHOD /path" (REST) or operation key (JSON-RPC) */
  byOp: Record<string, SpecwatchAgentExt>;
  opsWithData: number;
  avgResponseCompleteness: number | null; // null when no completeness data observed
  thinResponseOps: number; // operations with completeness < 0.5
  verificationLoopOps: number;
}

export interface CategoryResult {
  id: string;
  name: string;
  description: string;
  score: number; // 0..100
  weight: number;
  findings: Finding[];
  signals?: SignalResult[];
}

export interface GateResult {
  id: string;
  message: string;
  cap: number;
}

export interface ReadinessLevel {
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  description: string;
}

export interface ScoreResult {
  schemaVersion: "1.0";
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  level: ReadinessLevel;
  apiTitle: string;
  apiVersion: string;
  openapiVersion: string;
  operationCount: number;
  categories: CategoryResult[];
  gates: GateResult[];
  topSuggestions: string[];
  /** Present only when runtime evidence (Specwatch) was supplied/detected. */
  runtimeVerified?: boolean;
  runtimeOps?: number;
}

export function parseSpec(input: string): any {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty spec");
  try {
    return JSON.parse(trimmed);
  } catch {
    return yaml.load(trimmed);
  }
}

function gradeFor(score: number): ScoreResult["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// JAIRF readiness bands: ≥90 / 75–90 / 60–75 / 40–60 / <40.
function levelFor(score: number): ReadinessLevel {
  if (score >= 90)
    return {
      level: 4,
      label: "Level 4 — Agent-Optimized",
      description: "Strong autonomous-agent readiness signals.",
    };
  if (score >= 75)
    return {
      level: 3,
      label: "Level 3 — AI-Ready",
      description: "Strong agent-readiness signals with minor gaps.",
    };
  if (score >= 60)
    return {
      level: 2,
      label: "Level 2 — AI-Aware",
      description: "Usable but needs hardening for agents.",
    };
  if (score >= 40)
    return {
      level: 1,
      label: "Level 1 — Foundational",
      description: "Significant gaps; agents will struggle.",
    };
  return {
    level: 0,
    label: "Level 0 — Not Ready",
    description: "Low current readiness for AI agent consumption.",
  };
}

interface OpEntry {
  path: string;
  method: string;
  op: any;
}

function hasNamedHeader(headers: unknown, names: Set<string>): boolean {
  if (!headers || typeof headers !== "object") return false;
  return Object.keys(headers).some((name) => names.has(name.toLowerCase()));
}

function hasRateLimitHint(op: any): boolean {
  const rateLimitHeaders = new Set([
    "ratelimit",
    "rate-limit",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-rate-limit-limit",
    "x-rate-limit-remaining",
    "x-rate-limit-reset",
    "retry-after",
  ]);
  const responses = op.responses ?? {};
  if (responses["429"]) return true;
  return Object.values<any>(responses).some((response) =>
    hasNamedHeader(response?.headers, rateLimitHeaders),
  );
}

function hasIdempotencyHeader(op: any): boolean {
  const params = Array.isArray(op.parameters) ? op.parameters : [];
  return params.some(
    (param: any) =>
      String(param?.in ?? "").toLowerCase() === "header" &&
      String(param?.name ?? "").toLowerCase() === "idempotency-key",
  );
}

function hasUsefulSecurityRequirement(requirements: unknown): boolean {
  if (!Array.isArray(requirements) || requirements.length === 0) return false;
  return requirements.every(
    (requirement) =>
      requirement && typeof requirement === "object" && Object.keys(requirement).length > 0,
  );
}

function effectiveSecurityRequirements(spec: any, op: any): unknown {
  if (Array.isArray(op.security)) return op.security;
  return spec.security;
}

function isSensitiveOperation(entry: OpEntry): boolean {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(entry.method)) return true;
  const text = [
    entry.path,
    entry.op.operationId,
    entry.op.summary,
    entry.op.description,
    ...(Array.isArray(entry.op.tags) ? entry.op.tags : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(admins?|accounts?|customers?|credentials?|emails?|invoices?|logins?|payments?|profiles?|secrets?|tokens?|users?)\b/.test(
    text,
  );
}

function hasDeclaredServer(spec: any): boolean {
  if (Array.isArray(spec?.servers) && spec.servers.length > 0) return true;
  if (spec?.swagger && (typeof spec.host === "string" || typeof spec.basePath === "string")) {
    return true;
  }
  return Array.isArray(spec?.schemes) && spec.schemes.length > 0;
}

function collectOps(spec: any): OpEntry[] {
  const out: OpEntry[] = [];
  const paths = spec?.paths ?? {};
  const methods = ["get", "post", "put", "patch", "delete", "options", "head"];
  for (const [path, item] of Object.entries<any>(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const m of methods) {
      if (item[m]) out.push({ path, method: m.toUpperCase(), op: item[m] });
    }
  }
  return out;
}

const SPECWATCH_AGENT_KEY = "x-specwatch-agent";

/**
 * Extract Specwatch runtime evidence embedded as `x-specwatch-agent` extensions on
 * operations. Returns `present: false` when none are found, so a static-only spec
 * scores exactly as before — the runtime path is purely additive.
 */
export function extractRuntimeSignals(ops: OpEntry[]): RuntimeSignals {
  const byOp: Record<string, SpecwatchAgentExt> = {};
  for (const { path, method, op } of ops) {
    const ext = op?.[SPECWATCH_AGENT_KEY];
    if (ext && typeof ext === "object") byOp[`${method} ${path}`] = ext as SpecwatchAgentExt;
  }
  const entries = Object.values(byOp);
  const completeness = entries
    .map((e) => e.responseCompleteness)
    .filter((v): v is number => typeof v === "number");
  return {
    present: entries.length > 0,
    byOp,
    opsWithData: entries.length,
    avgResponseCompleteness:
      completeness.length === 0
        ? null
        : completeness.reduce((s, v) => s + v, 0) / completeness.length,
    thinResponseOps: completeness.filter((v) => v < 0.5).length,
    verificationLoopOps: entries.filter((e) => e.verificationLoopDetected === true).length,
  };
}

/**
 * Pull only the strings where a real credential would actually leak — server URLs
 * (and their variables) and OAuth/OIDC endpoint URLs. The secret scan uses this to
 * restrict its looser Bearer pattern to these fields, skipping documentation fields
 * (description, summary, examples, bearerFormat) that legitimately contain sample
 * tokens. Unambiguous provider-key formats are scanned over the whole document
 * separately, since those leak wherever they appear.
 */
function collectCredentialBearingStrings(spec: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  const servers: any[] = Array.isArray(spec?.servers) ? spec.servers : [];
  for (const s of servers) {
    push(s?.url);
    for (const v of Object.values<any>(s?.variables ?? {})) {
      push(v?.default);
      if (Array.isArray(v?.enum)) v.enum.forEach(push);
    }
  }
  const schemes = spec?.components?.securitySchemes ?? spec?.securityDefinitions ?? {};
  for (const sc of Object.values<any>(schemes)) {
    push(sc?.openIdConnectUrl);
    push(sc?.authorizationUrl); // OpenAPI 2.x oauth2
    push(sc?.tokenUrl); // OpenAPI 2.x oauth2
    for (const f of Object.values<any>(sc?.flows ?? {})) {
      push(f?.authorizationUrl);
      push(f?.tokenUrl);
      push(f?.refreshUrl);
    }
  }
  return out;
}

function collectServerTransports(spec: any): string[] {
  if (Array.isArray(spec?.servers) && spec.servers.length > 0) {
    return spec.servers
      .map((server: any) =>
        String(server?.url ?? "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  }
  if (Array.isArray(spec?.schemes) && spec.schemes.length > 0) {
    return spec.schemes.map((scheme: unknown) => `${String(scheme).toLowerCase()}://`);
  }
  return [];
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function extensionUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const candidate =
      (value as { url?: unknown; href?: unknown }).url ?? (value as { href?: unknown }).href;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function isUsefulObject(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return keys.some((key) => {
    const child = (value as Record<string, unknown>)[key];
    return Array.isArray(child) ? child.length > 0 : !!child;
  });
}

const sig = (r: number) => Math.max(0, Math.min(100, Math.round(r * 100)));
const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);

// JAIRF weighted harmonic aggregation: Σw / Σ(w / (score + ε)), ε = 1e-6.
// The harmonic mean intentionally lets any single weak dimension drag the whole
// score down. The previous Math.max(1, score) floor blunted that — a 0-scoring
// dimension was credited as if it scored 1 — so it is replaced by the spec's ε.
const HARMONIC_EPSILON = 1e-6;

function weightedHarmonicMean(items: { score: number; weight: number }[]): number {
  const totalW = items.reduce((s, i) => s + i.weight, 0);
  const denom = items.reduce((s, i) => s + i.weight / (i.score + HARMONIC_EPSILON), 0);
  return Math.round(totalW / denom);
}

function sevForScore(s: number): Severity {
  if (s >= 80) return "pass";
  if (s >= 50) return "warn";
  return "fail";
}

function resolveLocalRef(spec: any, ref: unknown): any {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  const parts = ref
    .replace(/^#\//, "")
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = spec;
  for (const part of parts) {
    if (!node || typeof node !== "object" || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function resolveSchema(schema: any, spec: any, seen = new Set<any>()): any {
  if (!schema || typeof schema !== "object") return undefined;
  if (!schema.$ref) return schema;
  const resolved = resolveLocalRef(spec, schema.$ref);
  if (!resolved || typeof resolved !== "object" || seen.has(resolved)) return undefined;
  return resolved;
}

function hasOwnExample(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  return node.example !== undefined || node.examples !== undefined;
}

function schemaHasExample(schema: any, spec: any, seen = new Set<any>()): boolean {
  if (!schema || typeof schema !== "object") return false;
  const resolved = schema.$ref ? resolveLocalRef(spec, schema.$ref) : schema;
  if (!resolved || typeof resolved !== "object" || seen.has(resolved)) return false;
  seen.add(resolved);

  if (hasOwnExample(resolved)) return true;

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (
      Array.isArray(resolved[key]) &&
      resolved[key].some((s: any) => schemaHasExample(s, spec, seen))
    ) {
      return true;
    }
  }
  if (schemaHasExample(resolved.items, spec, seen)) return true;
  if (resolved.additionalProperties && typeof resolved.additionalProperties === "object") {
    if (schemaHasExample(resolved.additionalProperties, spec, seen)) return true;
  }
  return Object.values<any>(resolved.properties ?? {}).some((property) =>
    schemaHasExample(property, spec, seen),
  );
}

function contentHasExample(content: any, spec: any): boolean {
  return Object.values<any>(content ?? {}).some(
    (media) => hasOwnExample(media) || schemaHasExample(media?.schema, spec),
  );
}

function collectContentSchemas(content: any): any[] {
  return Object.values<any>(content ?? {})
    .map((media) => media?.schema)
    .filter(Boolean);
}

function collectResponseSchemas(response: any): any[] {
  const schemas = collectContentSchemas(response?.content);
  if (response?.schema) schemas.push(response.schema);
  return schemas;
}

function schemaIsList(schema: any, spec: any, seen = new Set<any>()): boolean {
  const resolved = resolveSchema(schema, spec, seen);
  if (!resolved || typeof resolved !== "object") return false;
  if (seen.has(resolved)) return false;
  seen.add(resolved);
  if (resolved.type === "array" || resolved.items) return true;
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (
      Array.isArray(resolved[key]) &&
      resolved[key].some((s: any) => schemaIsList(s, spec, seen))
    ) {
      return true;
    }
  }
  for (const propertyName of ["data", "items", "results"] as const) {
    const property = resolved.properties?.[propertyName];
    const prop = resolveSchema(property, spec, seen) ?? property;
    if (prop?.type === "array" || prop?.items || schemaIsList(prop, spec, seen)) return true;
  }
  return false;
}

function schemaLooksLikeProblemDetails(schema: any, spec: any, seen = new Set<any>()): boolean {
  const resolved = resolveSchema(schema, spec, seen);
  if (!resolved || typeof resolved !== "object") return false;

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (
      Array.isArray(resolved[key]) &&
      resolved[key].some((s: any) => schemaLooksLikeProblemDetails(s, spec, seen))
    ) {
      return true;
    }
  }

  const properties = resolved.properties ?? {};
  const problemFields = ["type", "title", "status", "detail", "instance"].filter(
    (field) => field in properties,
  );
  return problemFields.length >= 3 && ("title" in properties || "detail" in properties);
}

function operationUsesProblemDetails(op: any, spec: any): boolean {
  const responses = op.responses ?? {};
  for (const [code, response] of Object.entries<any>(responses)) {
    if (!code.startsWith("4") && !code.startsWith("5")) continue;
    const contentEntries = Object.entries<any>(response?.content ?? {});
    if (contentEntries.some(([mediaType]) => mediaType.toLowerCase().includes("problem+json"))) {
      return true;
    }
    if (
      contentEntries.some(([, media]) => schemaLooksLikeProblemDetails(media?.schema, spec)) ||
      schemaLooksLikeProblemDetails(response?.schema, spec)
    ) {
      return true;
    }
  }
  return false;
}

function schemaTypeStats(
  schema: any,
  spec: any,
  seen = new Set<any>(),
): { total: number; score: number } {
  const resolved = resolveSchema(schema, spec, seen);
  if (!resolved || typeof resolved !== "object") return { total: 0, score: 0 };
  if (seen.has(resolved)) return { total: 0, score: 0 };
  seen.add(resolved);

  let total = 0;
  let score = 0;
  const add = (stats: { total: number; score: number }) => {
    total += stats.total;
    score += stats.score;
  };
  const addCurrent = (value: number) => {
    total += 1;
    score += value;
  };

  const type = typeof resolved.type === "string" ? resolved.type.toLowerCase() : "";
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) addCurrent(0.5);
  else if (type === "string" && resolved.format) addCurrent(0.75);
  else if (type === "string") addCurrent(0.25);
  else if (["integer", "number", "boolean"].includes(type)) addCurrent(1);
  else if (type === "array") addCurrent(1);
  else if (type === "object" && !resolved.properties && !resolved.additionalProperties)
    addCurrent(0);
  else if (
    !type &&
    !resolved.properties &&
    !resolved.items &&
    !resolved.allOf &&
    !resolved.anyOf &&
    !resolved.oneOf
  )
    addCurrent(0);

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(resolved[key])) {
      for (const child of resolved[key]) add(schemaTypeStats(child, spec, seen));
    }
  }
  add(schemaTypeStats(resolved.items, spec, seen));
  if (resolved.additionalProperties && typeof resolved.additionalProperties === "object") {
    add(schemaTypeStats(resolved.additionalProperties, spec, seen));
  }
  for (const property of Object.values<any>(resolved.properties ?? {})) {
    add(schemaTypeStats(property, spec, seen));
  }
  return { total, score };
}

function operationIdStyle(operationId: string): string {
  if (/^[a-z][A-Za-z0-9]*$/.test(operationId)) return "camel";
  if (/^[A-Z][A-Za-z0-9]*$/.test(operationId)) return "pascal";
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(operationId)) return "snake";
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(operationId)) return "kebab";
  return "other";
}

function mostCommonCount(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

function collectDescribableSchemaStats(
  schema: any,
  spec: any,
  seen = new Set<any>(),
): { expected: number; present: number } {
  if (!schema || typeof schema !== "object") return { expected: 0, present: 0 };
  const resolved = schema.$ref ? resolveLocalRef(spec, schema.$ref) : schema;
  if (!resolved || typeof resolved !== "object" || seen.has(resolved)) {
    return { expected: 0, present: 0 };
  }
  seen.add(resolved);

  const isTransparentContainer =
    !resolved.title &&
    !resolved.description &&
    !resolved.properties &&
    (resolved.type === "array" || resolved.allOf || resolved.anyOf || resolved.oneOf);
  let expected = isTransparentContainer ? 0 : 1;
  let present =
    !isTransparentContainer &&
    typeof resolved.description === "string" &&
    resolved.description.trim()
      ? 1
      : 0;
  const add = (stats: { expected: number; present: number }) => {
    expected += stats.expected;
    present += stats.present;
  };

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(resolved[key])) {
      for (const child of resolved[key]) add(collectDescribableSchemaStats(child, spec, seen));
    }
  }
  add(collectDescribableSchemaStats(resolved.items, spec, seen));
  if (resolved.additionalProperties && typeof resolved.additionalProperties === "object") {
    add(collectDescribableSchemaStats(resolved.additionalProperties, spec, seen));
  }
  for (const property of Object.values<any>(resolved.properties ?? {})) {
    add(collectDescribableSchemaStats(property, spec, seen));
  }
  return { expected, present };
}

function collectDescriptionStats(spec: any, info: any, ops: OpEntry[]) {
  let expected = 1;
  let present = typeof info.description === "string" && info.description.trim() ? 1 : 0;
  const seenSchemas = new Set<any>();

  const addObject = (node: any) => {
    expected += 1;
    if (typeof node?.description === "string" && node.description.trim()) present += 1;
  };
  const addSchema = (schema: any) => {
    const stats = collectDescribableSchemaStats(schema, spec, seenSchemas);
    expected += stats.expected;
    present += stats.present;
  };

  for (const { op } of ops) {
    addObject(op);
    for (const param of op.parameters ?? []) {
      addObject(param);
      addSchema(param?.schema);
    }
    if (op.requestBody) {
      addObject(op.requestBody);
      for (const media of Object.values<any>(op.requestBody.content ?? {})) {
        addSchema(media?.schema);
      }
    }
    for (const response of Object.values<any>(op.responses ?? {})) {
      addObject(response);
      for (const header of Object.values<any>(response?.headers ?? {})) addObject(header);
      for (const media of Object.values<any>(response?.content ?? {})) addSchema(media?.schema);
    }
  }
  for (const schema of Object.values<any>(spec.components?.schemas ?? spec.definitions ?? {})) {
    addSchema(schema);
  }

  return { expected, present };
}

/**
 * Shared, read-only inputs derived once from the spec and passed to each dimension
 * scorer. Each `score<Dim>()` function is pure: it reads from this context and returns
 * its CategoryResult plus any gating caps it raises (only SEC raises gates today).
 */
export interface DimensionInput {
  spec: any;
  info: any;
  openapiVersion: string;
  ops: OpEntry[];
  opCount: number;
  specText: string;
  specLower: string;
  runtime: RuntimeSignals;
}

export interface DimensionResult {
  category: CategoryResult;
  gates: GateResult[];
}

function buildCategory(
  id: string,
  name: string,
  description: string,
  weight: number,
  signals: SignalResult[],
  findings: Finding[],
): CategoryResult {
  return {
    id,
    name,
    description,
    weight,
    findings,
    signals: signals.map((s) => ({ ...s, confidence: s.confidence ?? "heuristic" })),
    score: signals.length
      ? Math.round(signals.reduce((s, x) => s + x.score, 0) / signals.length)
      : 0,
  };
}

// FC — Foundational Compliance (0.16)
export function scoreFC(ctx: DimensionInput): DimensionResult {
  const { spec, info, openapiVersion, ops, opCount, specText } = ctx;
  const findings: Finding[] = [];
  const sigs: SignalResult[] = [];
  // JAIRF scope covers both OpenAPI 2.x and 3.x. A well-formed spec of either
  // version (recognised version + a paths object) is valid; only an
  // unrecognised version scores 0, and a recognised version missing paths scores 50.
  const knownVersion = openapiVersion.startsWith("3") || openapiVersion.startsWith("2");
  const specValid = openapiVersion === "unknown" ? 0 : knownVersion && !!spec.paths ? 100 : 50;
  sigs.push({
    id: "spec_valid",
    name: "Spec validity (OpenAPI 2.x/3.x + paths)",
    score: specValid,
  });
  findings.push({
    severity: sevForScore(specValid),
    message: `OpenAPI version: ${openapiVersion}`,
  });

  const infoChecks = [!!info.title, !!info.version, !!info.description, hasDeclaredServer(spec)];
  const infoScore = sig(ratio(infoChecks.filter(Boolean).length, infoChecks.length));
  sigs.push({ id: "info_complete", name: "Info block completeness", score: infoScore });
  if (!info.title) findings.push({ severity: "fail", message: "Missing info.title" });
  if (!info.version) findings.push({ severity: "fail", message: "Missing info.version" });
  if (!info.description) findings.push({ severity: "warn", message: "Missing info.description" });
  if (!hasDeclaredServer(spec))
    findings.push({ severity: "fail", message: "No server location declared" });

  const refs = Array.from(specText.matchAll(/"\$ref":\s*"(#\/[^"]+)"/g)).map((m) => m[1]);
  const sample = refs.slice(0, 20);
  let refResolved = 0;
  for (const r of sample) {
    const parts = r
      .replace(/^#\//, "")
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node: any = spec;
    let ok = true;
    for (const p of parts) {
      if (node && p in node) node = node[p];
      else {
        ok = false;
        break;
      }
    }
    if (ok) refResolved++;
  }
  const refScore = sample.length === 0 ? 100 : sig(ratio(refResolved, sample.length));
  sigs.push({ id: "refs_resolvable", name: "$ref resolvability", score: refScore });
  if (sample.length && refResolved < sample.length) {
    findings.push({
      severity: "fail",
      message: `${sample.length - refResolved}/${sample.length} sampled $refs do not resolve`,
    });
  }

  let structuralOk = 0;
  for (const { op } of ops)
    if (op.responses && Object.keys(op.responses).length > 0) structuralOk++;
  sigs.push({
    id: "structural_integrity",
    name: "Structural integrity (responses present)",
    score: sig(ratio(structuralOk, opCount)),
  });

  return {
    category: buildCategory(
      "fc",
      "Foundational Compliance",
      "Spec validity, structural integrity, resolvable references.",
      0.16,
      sigs,
      findings,
    ),
    gates: [],
  };
}

// DXJ — Developer Experience & Tooling (0.18)
export function scoreDXJ(ctx: DimensionInput): DimensionResult {
  const { spec, info, ops, opCount } = ctx;
  const findings: Finding[] = [];
  const sigs: SignalResult[] = [];
  let reqEx = 0,
    respEx = 0,
    fullResponseCoverage = 0,
    responseCoverageTotal = 0;
  for (const { op } of ops) {
    const rb = op.requestBody?.content ?? {};
    if (contentHasExample(rb, spec)) reqEx++;
    const responses = op.responses ?? {};
    const has = Object.values(responses).some((r: any) => contentHasExample(r?.content, spec));
    if (has) respEx++;
    const codes = Object.keys(responses);
    const coverageParts = [
      codes.some((code) => code.startsWith("2")),
      codes.some((code) => code.startsWith("4")),
      codes.some((code) => code.startsWith("5")),
      codes.includes("default"),
    ];
    const covered = coverageParts.filter(Boolean).length;
    responseCoverageTotal += covered / coverageParts.length;
    if (covered === coverageParts.length) fullResponseCoverage++;
  }
  const componentsSchemas = Object.keys(spec.components?.schemas ?? spec.definitions ?? {}).length;
  const descriptionStats = collectDescriptionStats(spec, info, ops);
  const reqExScore = sig(ratio(reqEx, opCount));
  const respExScore = sig(ratio(respEx, opCount));
  const respCovScore = sig(ratio(responseCoverageTotal, opCount));
  const docClarityScore = sig(ratio(descriptionStats.present, descriptionStats.expected));
  const reuseScore = componentsSchemas === 0 ? 0 : Math.min(100, 20 + componentsSchemas * 8);
  sigs.push({ id: "request_examples", name: "Request examples coverage", score: reqExScore });
  sigs.push({ id: "response_examples", name: "Response examples coverage", score: respExScore });
  sigs.push({ id: "response_2xx_coverage", name: "Response coverage", score: respCovScore });
  sigs.push({
    id: "doc_clarity",
    name: "Description coverage",
    score: docClarityScore,
  });
  sigs.push({ id: "schema_reuse", name: "Reusable component schemas", score: reuseScore });
  findings.push({
    severity: sevForScore(respExScore),
    message:
      respEx === ops.length
        ? `All ${ops.length} operations include response or schema examples`
        : `Add response or schema examples to ${ops.length - respEx} of ${ops.length} operations`,
  });
  findings.push({
    severity: sevForScore(docClarityScore),
    message: `${descriptionStats.present}/${descriptionStats.expected} describable elements include descriptions`,
  });
  findings.push({
    severity: sevForScore(respCovScore),
    message:
      fullResponseCoverage === ops.length
        ? `All ${ops.length} operations document success, client-error, server-error, and default responses`
        : `Add broader response coverage to ${ops.length - fullResponseCoverage} of ${ops.length} operations`,
  });
  if (componentsSchemas === 0)
    findings.push({ severity: "warn", message: "No reusable schemas in components.schemas" });
  else
    findings.push({
      severity: "pass",
      message: `${componentsSchemas} reusable component schema(s)`,
    });
  return {
    category: buildCategory(
      "dxj",
      "Developer Experience & Tooling",
      "Examples, doc clarity, response coverage, tooling readiness.",
      0.18,
      sigs,
      findings,
    ),
    gates: [],
  };
}

// ARAX — AI-Readiness & Agent Experience (0.24)
export function scoreARAX(ctx: DimensionInput): DimensionResult {
  const { spec, info, ops, opCount } = ctx;
  const findings: Finding[] = [];
  const sigs: SignalResult[] = [];
  let withSummary = 0,
    withOpId = 0;
  const typeStats = { total: 0, score: 0 };
  const addTypeStats = (stats: { total: number; score: number }) => {
    typeStats.total += stats.total;
    typeStats.score += stats.score;
  };
  for (const { op } of ops) {
    if (op.summary) withSummary++;
    if (op.operationId) withOpId++;
    const params = op.parameters ?? [];
    for (const p of params) {
      addTypeStats(schemaTypeStats(p.schema ?? p, spec));
    }
    for (const media of Object.values<any>(op.requestBody?.content ?? {})) {
      addTypeStats(schemaTypeStats(media?.schema, spec));
    }
    for (const response of Object.values<any>(op.responses ?? {})) {
      for (const schema of collectResponseSchemas(response))
        addTypeStats(schemaTypeStats(schema, spec));
    }
  }
  for (const schema of Object.values<any>(spec.components?.schemas ?? spec.definitions ?? {})) {
    addTypeStats(schemaTypeStats(schema, spec));
  }
  const sumScore = sig(ratio(withSummary, opCount));
  const descriptionStats = collectDescriptionStats(spec, info, ops);
  const descScore = sig(ratio(descriptionStats.present, descriptionStats.expected));
  const opIds = ops.map(({ op }) => String(op.operationId ?? "")).filter(Boolean);
  const opIdCoverage = ratio(withOpId, opCount);
  const opIdUniqueness =
    opIds.length === 0 ? 0 : ratio(new Set(opIds.map((id) => id.toLowerCase())).size, opIds.length);
  const opIdCasing =
    opIds.length === 0 ? 0 : ratio(mostCommonCount(opIds.map(operationIdStyle)), opIds.length);
  const opIdScore = sig(opIdCoverage * opIdUniqueness * opIdCasing);
  // Coverage normalisation (JAIRF): zero expected occurrences ⇒ coverage 1.0 (100).
  const typeScore = typeStats.total === 0 ? 100 : sig(typeStats.score / typeStats.total);

  let problemDetails = 0;
  for (const { op } of ops) {
    if (operationUsesProblemDetails(op, spec)) problemDetails++;
  }
  const errScore = sig(ratio(problemDetails, opCount));
  const policyOps = ops.filter(({ op }) => hasRateLimitHint(op)).length;
  const policyScore = opCount === 0 ? 30 : 30 + Math.round(ratio(policyOps, opCount) * 70);

  sigs.push({ id: "summary_coverage", name: "Summary coverage", score: sumScore });
  sigs.push({
    id: "description_coverage",
    name: "Description coverage",
    score: descScore,
  });
  sigs.push({ id: "operationid_quality", name: "operationId quality", score: opIdScore });
  sigs.push({ id: "type_specificity", name: "Schema type specificity", score: typeScore });
  sigs.push({
    id: "error_standardization",
    name: "Error standardization (+ RFC 9457)",
    score: errScore,
  });
  sigs.push({ id: "policy_presence", name: "Rate-limit / policy hints", score: policyScore });

  findings.push({
    severity: sevForScore(sumScore),
    message:
      withSummary === ops.length
        ? `All ${ops.length} operations have a summary`
        : `Add a summary to ${ops.length - withSummary} of ${ops.length} operations`,
  });
  findings.push({
    severity: sevForScore(descScore),
    message:
      descriptionStats.present === descriptionStats.expected
        ? `All ${descriptionStats.expected} describable elements include descriptions`
        : `Add descriptions to ${descriptionStats.expected - descriptionStats.present} of ${descriptionStats.expected} describable elements`,
  });
  findings.push({
    severity: sevForScore(opIdScore),
    message:
      opIdScore >= 100
        ? `All ${ops.length} operations declare unique, consistently cased operationIds`
        : `Improve operationId coverage, uniqueness, or casing consistency (${opIdScore}/100)`,
  });
  if (problemDetails > 0)
    findings.push({
      severity: "pass",
      message: `${problemDetails} op(s) use problem-details error bodies (RFC 7807/9457)`,
    });
  else
    findings.push({
      severity: "warn",
      message: "No problem-details error bodies (RFC 7807/9457 recommended)",
    });
  findings.push({
    severity: sevForScore(policyScore),
    message:
      policyOps === ops.length
        ? `All ${ops.length} operations expose rate-limit hints`
        : `Add 429 responses or rate-limit headers to ${ops.length - policyOps} of ${ops.length} operations`,
  });

  // Runtime evidence (Specwatch): verification loops are a pure-runtime symptom a
  // static spec read cannot see. A loop means an agent had to re-fetch to confirm a
  // write — the response didn't tell it enough. Score is the share of observed ops
  // that did NOT trigger a loop.
  const { runtime } = ctx;
  if (runtime.present) {
    const loopFreeRate = ratio(
      runtime.opsWithData - runtime.verificationLoopOps,
      runtime.opsWithData,
    );
    const loopScore = sig(loopFreeRate);
    sigs.push({
      id: "observed_verification_loops",
      name: "Observed verification-loop freedom",
      score: loopScore,
      confidence: "observed",
    });
    findings.push({
      severity: sevForScore(loopScore),
      message:
        runtime.verificationLoopOps === 0
          ? `No verification loops observed across ${runtime.opsWithData} traced operation(s)`
          : `Verification loops observed on ${runtime.verificationLoopOps} of ${runtime.opsWithData} traced operation(s) — thicken write responses so agents needn't re-fetch`,
    });
  }

  return {
    category: buildCategory(
      "arax",
      "AI-Readiness & Agent Experience",
      "Semantics agents rely on: summaries, types, standardized errors, policies.",
      0.24,
      sigs,
      findings,
    ),
    gates: [],
  };
}

// AU — Agent Usability (0.20)
export function scoreAU(ctx: DimensionInput): DimensionResult {
  const { spec, ops, opCount } = ctx;
  const findings: Finding[] = [];
  const sigs: SignalResult[] = [];
  const opIds = ops.map((o) => o.op.operationId).filter(Boolean) as string[];
  const uniqueIds = new Set(opIds.map((id) => id.toLowerCase()));
  const distinctScore = opIds.length === 0 ? 0 : sig(ratio(uniqueIds.size, opIds.length));

  let paramSum = 0;
  for (const { op } of ops) paramSum += (op.parameters?.length ?? 0) + (op.requestBody ? 1 : 0);
  const avgParams = paramSum / opCount;
  const complexityScore = sig(Math.max(0, 1 - Math.max(0, avgParams - 6) / 10));

  const paginationParams = new Set([
    "page",
    "per_page",
    "limit",
    "offset",
    "cursor",
    "after",
    "before",
    "page_size",
    "pagetoken",
    "page_token",
  ]);
  let listOps = 0,
    paginated = 0;
  for (const { op, method } of ops) {
    if (method !== "GET") continue;
    const ok = op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["default"];
    const isList = collectResponseSchemas(ok).some((schema) => schemaIsList(schema, spec));
    if (!isList) continue;
    listOps++;
    const params = op.parameters ?? [];
    if (params.some((p: any) => paginationParams.has(String(p.name ?? "").toLowerCase()))) {
      paginated++;
    }
  }
  // Coverage normalisation (JAIRF): no list endpoints ⇒ nothing to paginate ⇒ 100.
  const pageScore = listOps === 0 ? 100 : sig(ratio(paginated, listOps));

  const writeOps = ops.filter((o) => ["POST", "PUT", "PATCH", "DELETE"].includes(o.method));
  const idemOps = writeOps.filter(({ op }) => hasIdempotencyHeader(op)).length;
  // Coverage normalisation (JAIRF): no mutating ops ⇒ no idempotency concern ⇒ 100.
  const idemScore =
    writeOps.length === 0 ? 100 : 30 + Math.round(ratio(idemOps, writeOps.length) * 70);

  let toolReady = 0;
  for (const { op } of ops) {
    if (op.operationId && op.summary && String(op.summary).length <= 120) toolReady++;
  }
  const toolScore = sig(ratio(toolReady, opCount));

  sigs.push({
    id: "complexity",
    name: "Operation complexity (avg inputs)",
    score: complexityScore,
  });
  sigs.push({ id: "distinctiveness", name: "Unique operationIds", score: distinctScore });
  sigs.push({ id: "pagination", name: "Pagination on list endpoints", score: pageScore });
  sigs.push({ id: "idempotency_safety", name: "Idempotency for mutating ops", score: idemScore });
  sigs.push({ id: "tool_calling", name: "Tool-calling alignment", score: toolScore });

  findings.push({
    severity: sevForScore(complexityScore),
    message: `Average ${avgParams.toFixed(1)} inputs per operation`,
  });
  if (listOps > 0)
    findings.push({
      severity: sevForScore(pageScore),
      message:
        paginated === listOps
          ? `All ${listOps} list endpoints declare pagination params`
          : `Add pagination params to ${listOps - paginated} of ${listOps} list endpoints`,
    });
  findings.push({
    severity: sevForScore(idemScore),
    message:
      writeOps.length === 0
        ? "No mutating operations to assess for idempotency"
        : idemOps === writeOps.length
          ? `All ${writeOps.length} mutating op(s) declare an Idempotency-Key header`
          : `Add Idempotency-Key header params to ${writeOps.length - idemOps} of ${writeOps.length} mutating op(s)`,
  });
  if (opIds.length !== uniqueIds.size)
    findings.push({
      severity: "fail",
      message: `Duplicate operationIds after case normalization: ${opIds.length - uniqueIds.size}`,
    });

  // Runtime evidence (Specwatch): thin write responses (a POST returns far fewer
  // fields than the matching GET) force agents into extra reads. Observed
  // completeness directly measures that — invisible to a static read.
  const { runtime } = ctx;
  if (runtime.present && runtime.avgResponseCompleteness !== null) {
    const completenessScore = sig(runtime.avgResponseCompleteness);
    sigs.push({
      id: "observed_response_completeness",
      name: "Observed response completeness",
      score: completenessScore,
      confidence: "observed",
    });
    findings.push({
      severity: sevForScore(completenessScore),
      message:
        runtime.thinResponseOps === 0
          ? `Write responses returned complete payloads across all traced operations`
          : `${runtime.thinResponseOps} traced write op(s) returned thin responses (<50% of read fields) — return the created/updated resource in full`,
    });
  }

  return {
    category: buildCategory(
      "au",
      "Agent Usability",
      "Predictability, complexity, pagination, safe retries, tool-calling fit.",
      0.2,
      sigs,
      findings,
    ),
    gates: [],
  };
}

// SEC — Security (0.12)
export function scoreSEC(ctx: DimensionInput): DimensionResult {
  const { spec, ops, specText } = ctx;
  const findings: Finding[] = [];
  const sigs: SignalResult[] = [];
  const gates: GateResult[] = [];
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const schemeCount = Object.keys(schemes).length;
  const sensitiveOps = ops.filter(isSensitiveOperation);
  const protectedSensitiveOps =
    schemeCount === 0
      ? []
      : sensitiveOps.filter(({ op }) =>
          hasUsefulSecurityRequirement(effectiveSecurityRequirements(spec, op)),
        );
  const authCoverage =
    sensitiveOps.length === 0 ? 100 : sig(ratio(protectedSensitiveOps.length, sensitiveOps.length));
  sigs.push({ id: "auth_coverage", name: "Authentication coverage", score: authCoverage });

  let strength = 0;
  for (const s of Object.values<any>(schemes)) {
    const t = (s.type || "").toLowerCase();
    const scheme = (s.scheme || "").toLowerCase();
    let v = 0;
    if (t === "oauth2" || t === "openidconnect") v = 100;
    else if (t === "http" && scheme === "bearer") v = 80;
    else if (t === "apikey") v = 60;
    else if (t === "http" && scheme === "basic") v = 40;
    strength = Math.max(strength, v);
  }
  sigs.push({
    id: "auth_strength",
    name: "Authentication strength",
    score: schemeCount === 0 ? 0 : strength,
  });

  const transports = collectServerTransports(spec);
  const httpServers = transports.filter((url) => /^http:\/\//i.test(url));
  const httpsOk =
    transports.length === 0
      ? 50
      : sig(ratio(transports.length - httpServers.length, transports.length));
  sigs.push({ id: "transport_security", name: "Transport security (HTTPS)", score: httpsOk });
  if (httpServers.length > 0) {
    findings.push({
      severity: "fail",
      message: `${httpServers.length} server transport(s) allow http:// (insecure)`,
    });
    gates.push({ id: "non_tls", message: "Non-TLS public server URL detected", cap: 50 });
  }

  // Provider-key formats are unambiguous credentials wherever they appear → scan the
  // whole document. The looser Bearer pattern also matches documented sample tokens
  // (in descriptions, examples, bearerFormat), so restrict it to credential-bearing
  // fields. This stops a spec that merely documents a JWT example from being gated.
  const providerKeyPatterns = [
    /sk_live_[a-z0-9]{16,}/i,
    /sk_test_[a-z0-9]{16,}/i,
    /AIza[0-9A-Za-z_-]{30,}/,
    /AKIA[0-9A-Z]{16}/,
  ];
  const bearerPattern = /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/;
  const credentialFields = collectCredentialBearingStrings(spec);
  const keyLeak = providerKeyPatterns.some((re) => re.test(specText));
  const bearerLeak = credentialFields.some((v) => bearerPattern.test(v));
  const leaked = keyLeak || bearerLeak;
  sigs.push({ id: "secret_hygiene", name: "Secret hygiene", score: leaked ? 0 : 100 });
  if (leaked) {
    findings.push({
      severity: "fail",
      message: "Hardcoded credential detected in a server URL or auth endpoint",
    });
    gates.push({ id: "hardcoded_secret", message: "Hardcoded secret detected in spec", cap: 40 });
  }

  if (schemeCount === 0) {
    findings.push({
      severity: sensitiveOps.length > 0 ? "fail" : "warn",
      message:
        sensitiveOps.length > 0
          ? `No security schemes declared for ${sensitiveOps.length} sensitive/state-changing op(s)`
          : "No security schemes declared",
    });
    if (sensitiveOps.length > 0) {
      gates.push({ id: "no_auth", message: "No authentication scheme declared", cap: 60 });
    }
  } else {
    findings.push({
      severity: sevForScore(authCoverage),
      message:
        sensitiveOps.length === 0
          ? `${schemeCount} security scheme(s): ${Object.keys(schemes).join(", ")}`
          : `${protectedSensitiveOps.length}/${sensitiveOps.length} sensitive/state-changing op(s) protected by effective security requirements`,
    });
  }

  return {
    category: buildCategory(
      "sec",
      "Security",
      "Auth coverage & strength, TLS transport, secret hygiene.",
      0.12,
      sigs,
      findings,
    ),
    gates,
  };
}

// AID — AI Discoverability (0.10)
export function scoreAID(ctx: DimensionInput): DimensionResult {
  const { spec, info, ops, opCount } = ctx;
  const findings: Finding[] = [];
  const sigs: SignalResult[] = [];
  const descriptionStats = collectDescriptionStats(spec, info, ops);
  const richness = sig(ratio(descriptionStats.present, descriptionStats.expected));
  sigs.push({
    id: "descriptive_richness",
    name: "Descriptive richness",
    score: richness,
  });

  const verbs = [
    "get",
    "list",
    "create",
    "update",
    "delete",
    "fetch",
    "retrieve",
    "send",
    "search",
    "find",
    "set",
    "remove",
    "add",
    "post",
    "patch",
    "put",
    "register",
    "cancel",
  ];
  let verbStart = 0,
    withSum = 0;
  for (const { op } of ops) {
    if (!op.summary) continue;
    withSum++;
    const first = String(op.summary)
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, "");
    if (first && verbs.includes(first)) verbStart++;
  }
  const intentScore = withSum === 0 ? 0 : sig(ratio(verbStart, withSum));
  sigs.push({ id: "intent_phrasing", name: "Verb-led summaries", score: intentScore });

  const tagged = ops.filter((o) => o.op.tags?.length).length;
  sigs.push({
    id: "domain_tagging",
    name: "Operation tagging",
    score: sig(ratio(tagged, opCount)),
  });

  const externalDocsHit = isHttpUrl(spec?.externalDocs?.url) ? 1 : 0;
  const llmsUrl = extensionUrl(spec?.["x-llms"]);
  const llmsHit =
    llmsUrl && isHttpUrl(llmsUrl) && llmsUrl.toLowerCase().includes("llms.txt") ? 1 : 0;
  const apisJsonUrl = extensionUrl(spec?.["x-apis-json"]);
  const apisJsonHit =
    apisJsonUrl && isHttpUrl(apisJsonUrl) && apisJsonUrl.toLowerCase().includes("apis.json")
      ? 1
      : 0;
  const arazzo = spec?.["x-arazzo"];
  const arazzoHit =
    isHttpUrl(extensionUrl(arazzo)) || isUsefulObject(arazzo, ["workflows", "sourceDescriptions"])
      ? 1
      : 0;
  const mcp = spec?.["x-mcp"];
  const mcpHit = isHttpUrl(extensionUrl(mcp)) || isUsefulObject(mcp, ["servers", "tools"]) ? 1 : 0;
  const regHits = externalDocsHit + llmsHit + apisJsonHit + arazzoHit + mcpHit;
  const regScore = regHits === 0 ? 20 : Math.min(100, 40 + regHits * 20);
  sigs.push({
    id: "registry_signals",
    name: "Registry signals (externalDocs, llms.txt, Arazzo, MCP)",
    score: regScore,
  });

  findings.push({
    severity: sevForScore(intentScore),
    message:
      withSum === 0
        ? "No operation summaries to assess"
        : verbStart === withSum
          ? `All ${withSum} summaries start with an action verb`
          : `Rephrase ${withSum - verbStart} of ${withSum} summaries to start with an action verb (e.g. "List", "Create")`,
  });
  findings.push({
    severity: sevForScore(richness),
    message:
      descriptionStats.present === descriptionStats.expected
        ? `All ${descriptionStats.expected} describable elements include descriptions`
        : `Add descriptions to ${descriptionStats.expected - descriptionStats.present} of ${descriptionStats.expected} describable elements`,
  });

  return {
    category: buildCategory(
      "aid",
      "AI Discoverability",
      "Descriptive richness, intent phrasing, tagging, registry signals.",
      0.1,
      sigs,
      findings,
    ),
    gates: [],
  };
}

/** Dimension scorers, in the canonical category order (FC, DXJ, ARAX, AU, SEC, AID). */
const DIMENSIONS: ((ctx: DimensionInput) => DimensionResult)[] = [
  scoreFC,
  scoreDXJ,
  scoreARAX,
  scoreAU,
  scoreSEC,
  scoreAID,
];

export function scoreSpec(spec: any, opts: { runtime?: RuntimeSignals } = {}): ScoreResult {
  if (!spec || typeof spec !== "object") throw new Error("Spec is not a valid object");

  const openapiVersion: string = spec.openapi || spec.swagger || "unknown";
  const info = spec.info ?? {};
  const ops = collectOps(spec);
  const specText = JSON.stringify(spec);
  const specLower = specText.toLowerCase();
  const opCount = Math.max(1, ops.length);

  // Runtime evidence: caller-supplied, else auto-detected from embedded
  // x-specwatch-agent extensions. Absent → present:false → identical to before.
  const runtime = opts.runtime ?? extractRuntimeSignals(ops);

  const ctx: DimensionInput = {
    spec,
    info,
    openapiVersion,
    ops,
    opCount,
    specText,
    specLower,
    runtime,
  };

  const categories: CategoryResult[] = [];
  const gates: GateResult[] = [];
  // Keep each dimension's gates with the dimension that raised them so caps can be
  // applied to that dimension's score rather than to the overall index.
  const scopedGates: { dimId: string; gate: GateResult }[] = [];
  for (const dimension of DIMENSIONS) {
    const result = dimension(ctx);
    categories.push(result.category);
    for (const gate of result.gates) {
      gates.push(gate);
      scopedGates.push({ dimId: result.category.id, gate });
    }
  }

  // JAIRF gating rule: a cap applies only to the affected dimension's score, never to
  // the overall index or other dimensions. Apply before aggregation so the capped
  // dimension propagates through the harmonic mean (one insecure server URL drags the
  // SEC dimension, not the whole score).
  for (const { dimId, gate } of scopedGates) {
    const cat = categories.find((c) => c.id === dimId);
    if (cat) cat.score = Math.min(cat.score, gate.cap);
  }

  // JAIRF gating rule: Foundational Compliance below 40 forces readiness to Level 0 —
  // a structurally broken spec is not agent-usable regardless of the numeric index.
  const fc = categories.find((c) => c.id === "fc");
  const fcFloor = !!fc && fc.score < 40;
  if (fcFloor) {
    gates.push({
      id: "fc_floor",
      message: "Foundational Compliance below 40 — spec not usable by agents (forced Level 0)",
      cap: 0,
    });
  }

  const overall = weightedHarmonicMean(
    categories.map((c) => ({ score: c.score, weight: c.weight })),
  );

  const topSuggestions = categories
    .slice()
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => `Improve ${c.name} (${c.score}/100)`);

  return {
    schemaVersion: "1.0",
    overall,
    grade: gradeFor(overall),
    level: fcFloor ? levelFor(0) : levelFor(overall),
    apiTitle: info.title || "Untitled API",
    apiVersion: info.version || "—",
    openapiVersion,
    operationCount: ops.length,
    categories,
    gates,
    topSuggestions,
    // Conditional so static-only results are byte-identical to before (snapshot-safe).
    ...(runtime.present ? { runtimeVerified: true, runtimeOps: runtime.opsWithData } : {}),
  };
}
