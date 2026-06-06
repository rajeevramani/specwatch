/**
 * Spec ablation generator (specwatch-sl1).
 *
 * Takes the hand-authored gold OpenAPI 3.1 spec and emits N variants, each
 * degrading exactly one phase-1 JAIRF signal FAMILY (a family spans several
 * coupled JAIRF keys; per-key isolation isn't achievable), plus an all-bad
 * variant. Every
 * emitted variant is:
 *   - valid OpenAPI 3.1 (openapi/info/paths preserved),
 *   - different from gold in exactly one signal family (asserted via diff in the
 *     companion test),
 *   - tagged with the JAIRF score @agentready/scoring computes for it, with a
 *     per-signal breakdown, written to a machine-readable manifest.
 *
 * The variants:
 *   gold            none — copy of the baseline, for reference.
 *   no-descriptions strip all operation/param/schema/info descriptions.
 *   bad-operationids remove some operationIds and mangle the casing of the rest
 *                    (introduces a casing-style conflict + a duplicate).
 *   no-examples     strip every request/response/schema `example`/`examples`.
 *   no-error-schemas remove the schema/content from every 4xx/5xx (and default)
 *                    response, so error bodies are no longer described.
 *   thin-responses  response completeness is a RUNTIME signal driven by the
 *                    backend THIN_RESPONSES toggle, NOT a spec edit. The emitted
 *                    spec is byte-identical to gold; degradation happens when the
 *                    runner runs the backend with THIN_RESPONSES=1. Documented in
 *                    the manifest via `runtimeDriven: true`.
 *   all-bad         every spec-level degradation above applied at once (and the
 *                    thin-responses runtime toggle is expected alongside it).
 *
 * Human-runnable entrypoint (from eval/calibration/backend):
 *   npm run ablate          # regenerate variants + manifest
 *
 * Output: eval/calibration/variants/<name>.yaml + variants/manifest.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseSpec, scoreSpec, type ScoreResult } from './packages/agentready-scoring/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = resolve(here, 'specs/gold.yaml');
const OUT_DIR = resolve(here, 'variants');

/** Signal families a variant can degrade — one per spec-level ablation. */
export type SignalFamily =
  | 'descriptions'
  | 'operationId'
  | 'examples'
  | 'errorSchemas'
  | 'completeness';

/**
 * The JAIRF signal ids each family is allowed to move. A signal can surface
 * under several dimensions (e.g. descriptions show up as `doc_clarity` in DXJ,
 * `description_coverage` in ARAX, `descriptive_richness` in AID) — all are the
 * SAME underlying signal viewed from different dimensions, so they belong to one
 * family. A variant degrading family F must change ONLY signals in
 * SIGNAL_FAMILIES[F]; touching any other family's signal would break clean
 * attribution. `completeness` is runtime-only and moves no static signal.
 */
export const SIGNAL_FAMILIES: Record<SignalFamily, string[]> = {
  descriptions: ['doc_clarity', 'description_coverage', 'descriptive_richness'],
  operationId: ['operationid_quality', 'distinctiveness', 'tool_calling'],
  examples: ['request_examples', 'response_examples'],
  errorSchemas: ['error_standardization', 'type_specificity'],
  completeness: [],
};

export interface VariantDef {
  /** File-system / manifest name. */
  name: string;
  /** Human-readable description of what is degraded. */
  label: string;
  /**
   * The single signal family this variant degrades. `all-bad` lists every
   * spec-level family; `gold` degrades none.
   */
  degrades: SignalFamily[];
  /**
   * True when the degradation is realised at RUNTIME (backend toggle), so the
   * emitted spec equals gold. Only the completeness variant.
   */
  runtimeDriven: boolean;
  /** Mutator applied to a deep clone of the parsed gold spec. */
  mutate: (spec: any) => void;
}

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function eachOperation(spec: any, fn: (op: any, path: string, verb: string) => void): void {
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const verb of HTTP_VERBS) {
      if (item && typeof item === 'object' && item[verb]) fn(item[verb], path, verb);
    }
  }
}

/** Walk every object node in the spec, calling fn on each. */
function walk(node: any, fn: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn);
    return;
  }
  fn(node);
  for (const value of Object.values(node)) walk(value, fn);
}

// ---------------------------------------------------------------------------
// Mutators — each degrades exactly one signal family.
// ---------------------------------------------------------------------------

/** Recursively delete `description` from a schema and its sub-schemas. */
function stripSchemaDescriptions(schema: any, seen = new Set<any>()): void {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return;
  seen.add(schema);
  delete schema.description;
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key])) for (const s of schema[key]) stripSchemaDescriptions(s, seen);
  }
  stripSchemaDescriptions(schema.items, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    stripSchemaDescriptions(schema.additionalProperties, seen);
  }
  for (const prop of Object.values<any>(schema.properties ?? {})) stripSchemaDescriptions(prop, seen);
}

/**
 * Remove descriptions from every OPTIONAL describable element — operations,
 * parameters, request bodies, all schemas (request/response/component), response
 * headers, and tags. Response-object descriptions are KEPT: OpenAPI 3.1 requires
 * a Response Object `description`, so stripping it would make the document
 * structurally invalid. The info-block description is also preserved so FC's
 * `info_complete` is untouched (clean attribution). Operations + every parameter
 * + every schema dominate the describable-element count, so coverage still falls
 * sharply — the degradation is real, the document stays valid OpenAPI 3.1.
 */
function stripDescriptions(spec: any): void {
  for (const tag of spec.tags ?? []) delete tag.description;
  eachOperation(spec, (op) => {
    delete op.description;
    for (const param of op.parameters ?? []) {
      delete param.description;
      stripSchemaDescriptions(param.schema);
    }
    if (op.requestBody) {
      delete op.requestBody.description;
      for (const media of Object.values<any>(op.requestBody.content ?? {})) {
        stripSchemaDescriptions(media?.schema);
      }
    }
    for (const response of Object.values<any>(op.responses ?? {})) {
      // Keep response.description (required by OpenAPI 3.1); strip the rest.
      for (const header of Object.values<any>(response?.headers ?? {})) {
        delete header.description;
        stripSchemaDescriptions(header?.schema);
      }
      for (const media of Object.values<any>(response?.content ?? {})) {
        stripSchemaDescriptions(media?.schema);
      }
    }
  });
  for (const schema of Object.values<any>(spec.components?.schemas ?? {})) {
    stripSchemaDescriptions(schema);
  }
}

/**
 * Degrade operationId quality: drop the operationId on a third of operations and
 * mangle the casing of the rest into an inconsistent mix (snake/pascal/kebab),
 * forcing a casing-consistency conflict and dropping coverage.
 */
function mangleOperationIds(spec: any): void {
  const ops: any[] = [];
  eachOperation(spec, (op) => ops.push(op));
  ops.forEach((op, index) => {
    if (!op.operationId) return;
    const mod = index % 3;
    if (mod === 0) {
      // Drop the operationId entirely (coverage hit).
      delete op.operationId;
    } else if (mod === 1) {
      // snake_case mangle of the camelCase original.
      op.operationId = String(op.operationId)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
    } else {
      // Force a duplicate, non-descriptive id (uniqueness + descriptiveness hit).
      op.operationId = 'Op';
    }
  });
}

/** Strip every request/response/schema example everywhere. */
function stripExamples(spec: any): void {
  walk(spec, (node) => {
    if ('example' in node) delete node.example;
    if ('examples' in node) delete node.examples;
  });
}

/**
 * De-standardize every error response (4xx/5xx and `default`): drop the
 * problem-details schema and demote the media type from `application/problem+json`
 * to plain `application/json`. This degrades the `error_standardization` signal
 * (no RFC 9457 media type, no problem-shaped schema) WITHOUT collaterally
 * dropping example coverage — any existing example is re-homed under the plain
 * media type so the examples family stays untouched. Attribution stays clean.
 */
function removeErrorSchemas(spec: any): void {
  eachOperation(spec, (op) => {
    const responses = op.responses ?? {};
    for (const [code, response] of Object.entries<any>(responses)) {
      const isError = code === 'default' || /^[45]/.test(code);
      if (!isError || !response || typeof response !== 'object' || !response.content) continue;
      // Collect any example carried by the (problem+json) error body so we can
      // preserve example coverage under a plain media type.
      let example: any;
      for (const media of Object.values<any>(response.content)) {
        if (media?.example !== undefined) example = media.example;
      }
      // Undescribed error body: a plain media type with no problem-details schema
      // (so `error_standardization` fails), but the example is preserved so the
      // examples family stays untouched. The lost problem-details schema also
      // lowers `type_specificity` — both are error-shape signals, so attribution
      // stays within the errorSchemas family.
      const plain: any = {};
      if (example !== undefined) plain.example = example;
      response.content = { 'application/json': plain };
    }
  });
}

// ---------------------------------------------------------------------------
// Variant catalogue.
// ---------------------------------------------------------------------------

export const VARIANTS: VariantDef[] = [
  {
    name: 'gold',
    label: 'Baseline — no degradation.',
    degrades: [],
    runtimeDriven: false,
    mutate: () => {},
  },
  {
    name: 'no-descriptions',
    label: 'Strip all operation/parameter/schema/info descriptions.',
    degrades: ['descriptions'],
    runtimeDriven: false,
    mutate: stripDescriptions,
  },
  {
    name: 'bad-operationids',
    label: 'Remove some operationIds and mangle the casing of the rest.',
    degrades: ['operationId'],
    runtimeDriven: false,
    mutate: mangleOperationIds,
  },
  {
    name: 'no-examples',
    label: 'Strip all request/response/schema examples.',
    degrades: ['examples'],
    runtimeDriven: false,
    mutate: stripExamples,
  },
  {
    name: 'no-error-schemas',
    label: 'Remove schema/content from every 4xx/5xx/default response.',
    degrades: ['errorSchemas'],
    runtimeDriven: false,
    mutate: removeErrorSchemas,
  },
  {
    name: 'thin-responses',
    label:
      'Response completeness — RUNTIME signal via backend THIN_RESPONSES toggle. ' +
      'Spec equals gold; degradation is applied at run time, not in the document.',
    degrades: ['completeness'],
    runtimeDriven: true,
    mutate: () => {},
  },
  {
    name: 'all-bad',
    label: 'Every degradation at once — spec-level families plus completeness (runtime-driven, ' +
      'so THIN_RESPONSES is applied automatically like the thin-responses variant).',
    degrades: ['descriptions', 'operationId', 'examples', 'errorSchemas', 'completeness'],
    runtimeDriven: true,
    mutate: (spec) => {
      stripDescriptions(spec);
      mangleOperationIds(spec);
      stripExamples(spec);
      removeErrorSchemas(spec);
    },
  },
];

// ---------------------------------------------------------------------------
// Scoring / manifest shape.
// ---------------------------------------------------------------------------

/** Flatten a ScoreResult's per-signal scores into an id -> score map. */
export function signalScores(result: ScoreResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cat of result.categories) {
    for (const sig of cat.signals ?? []) out[sig.id] = sig.score;
  }
  return out;
}

export interface ManifestEntry {
  name: string;
  label: string;
  degrades: SignalFamily[];
  runtimeDriven: boolean;
  /** Relative path to the emitted spec file. */
  spec: string;
  jairf: {
    overall: number;
    grade: ScoreResult['grade'];
    level: number;
  };
  /** category id -> category score. */
  categories: Record<string, number>;
  /** signal id -> signal score. */
  signals: Record<string, number>;
}

export interface Manifest {
  generatedAt: string;
  gold: string;
  variants: ManifestEntry[];
}

/**
 * Invariant: a variant is runtime-driven iff it degrades `completeness` (the only
 * runtime signal, applied via the backend `THIN_RESPONSES` toggle, not the spec).
 * Hand-set `runtimeDriven` and the `degrades` list must agree — otherwise a variant
 * can declare completeness yet never apply it at run time (the specwatch-hfe bug,
 * where `all-bad` had `runtimeDriven: false`). This guard fails the build on drift.
 */
function assertRuntimeDrivenConsistent(def: VariantDef): void {
  const declaresCompleteness = def.degrades.includes('completeness');
  if (def.runtimeDriven !== declaresCompleteness) {
    throw new Error(
      `Variant "${def.name}": runtimeDriven=${def.runtimeDriven} but degrades ` +
        `completeness=${declaresCompleteness}. A completeness-degrading variant must be ` +
        `runtimeDriven (so THIN_RESPONSES is applied); a non-completeness one must not be.`,
    );
  }
}

/** Build a single variant's spec object + manifest entry (no file I/O). */
export function buildVariant(gold: any, def: VariantDef): { spec: any; entry: ManifestEntry } {
  assertRuntimeDrivenConsistent(def);
  const spec = clone(gold);
  def.mutate(spec);
  const result = scoreSpec(spec);
  const categories: Record<string, number> = {};
  for (const cat of result.categories) categories[cat.id] = cat.score;
  return {
    spec,
    entry: {
      name: def.name,
      label: def.label,
      degrades: def.degrades,
      runtimeDriven: def.runtimeDriven,
      spec: `variants/${def.name}.yaml`,
      jairf: { overall: result.overall, grade: result.grade, level: result.level.level },
      categories,
      signals: signalScores(result),
    },
  };
}

/** Generate all variants in-memory (spec object + manifest entry per variant). */
export function generate(gold: any): Array<{ def: VariantDef; spec: any; entry: ManifestEntry }> {
  return VARIANTS.map((def) => ({ def, ...buildVariant(gold, def) }));
}

function dumpYaml(spec: any): string {
  return yaml.dump(spec, { lineWidth: 100, noRefs: true, sortKeys: false });
}

/** Write every variant YAML + the manifest to OUT_DIR. Returns the manifest. */
export function writeAll(gold: any, outDir = OUT_DIR): Manifest {
  mkdirSync(outDir, { recursive: true });
  const generated = generate(gold);
  for (const { def, spec } of generated) {
    writeFileSync(resolve(outDir, `${def.name}.yaml`), dumpYaml(spec), 'utf8');
  }
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    gold: 'specs/gold.yaml',
    variants: generated.map((g) => g.entry),
  };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

/** Load + parse the gold spec. */
export function loadGold(path = GOLD_PATH): any {
  return parseSpec(readFileSync(path, 'utf8'));
}

// CLI entrypoint.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const gold = loadGold();
  const manifest = writeAll(gold);
  console.log(`\nWrote ${manifest.variants.length} variants -> ${OUT_DIR}\n`);
  for (const v of manifest.variants) {
    const tag = v.runtimeDriven ? ' (runtime-driven)' : '';
    const deg = v.degrades.length ? v.degrades.join(',') : 'none';
    console.log(
      `  ${v.name.padEnd(18)} JAIRF ${String(v.jairf.overall).padStart(3)} ${v.jairf.grade}` +
        `  degrades: ${deg}${tag}`,
    );
  }
  console.log(`\nManifest: ${resolve(OUT_DIR, 'manifest.json')}\n`);
}
