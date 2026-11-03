import { describe, expect, it } from 'vitest';
import type { AggregatedSchema, InferredSchema } from '../types/index.js';
import { prepareLearnedSchemasForExport } from './learned-contract.js';
import { buildOpenApiDocument, convertSchemaToOpenApi, convertToOpenApi30 } from './openapi.js';
import { discoverDomainModels } from './domain-models.js';

const stats = { sampleCount: 20, presenceCount: 20, confidence: 1 };
const leaf = (): InferredSchema => ({
  type: 'string',
  enum: ['alpha', 'beta'],
  stats: { ...stats },
});
function body(): InferredSchema {
  return {
    type: 'object',
    stats: { ...stats },
    required: ['enum', 'values', 'nullable'],
    properties: {
      enum: leaf(),
      values: { type: 'array', items: leaf(), stats: { ...stats } },
      nullable: {
        type: 'null',
        stats: { ...stats },
        oneOf: [leaf(), { type: 'null', stats: { ...stats } }],
      },
      identifier: { type: 'string', format: 'uuid', stats: { ...stats } },
    },
  };
}
function endpoint(path: string): AggregatedSchema {
  return {
    id: 1,
    sessionId: 'owned-policy-unit',
    httpMethod: 'POST',
    path,
    version: 1,
    snapshot: 1,
    requestSchema: body(),
    responseSchemas: { '200': body(), '204': null },
    sampleCount: 20,
    confidenceScore: 1,
    queryParams: { enum: ['alpha', 'beta'] },
    pathParamValues: { id: ['1', '2'] },
    firstObserved: '2026-01-01',
    lastObserved: '2026-01-01',
  };
}
describe('learned-contract projection', () => {
  it('visits schema positions without deleting literal enum properties or learning metadata', () => {
    const input = [endpoint('/alpha')];
    const before = structuredClone(input);
    const projected = prepareLearnedSchemasForExport(input);
    expect(input).toEqual(before);
    const node = projected[0].requestSchema!;
    expect(node.properties!.enum).toBeDefined();
    expect(node.properties!.enum.enum).toBeUndefined();
    expect(node.properties!.values.items!.enum).toBeUndefined();
    expect(node.properties!.nullable.oneOf![0].enum).toBeUndefined();
    expect(node.properties!.nullable.oneOf![1].type).toBe('null');
    expect(node.required).toEqual(before[0].requestSchema!.required);
    expect(node.properties!.identifier.format).toBe('uuid');
    expect(node.stats).toEqual(stats);
    expect(projected[0].responseSchemas!['200']!.properties!.enum.enum).toBeUndefined();
    expect(projected[0].responseSchemas!['204']).toBeNull();
    expect(projected[0].queryParams).toEqual(before[0].queryParams);
    expect(projected[0].pathParamValues).toEqual(before[0].pathParamValues);
    expect(projected[0].confidenceScore).toBe(1);
  });
  it('retains candidates on explicit opt-in and does not contaminate repeated projections', () => {
    const input = [endpoint('/alpha')];
    const before = structuredClone(input);
    expect(prepareLearnedSchemasForExport(input, true)).toEqual(before);
    prepareLearnedSchemasForExport(input);
    expect(prepareLearnedSchemasForExport(input, true)).toEqual(before);
    expect(input).toEqual(before);
    expect(prepareLearnedSchemasForExport([])).toEqual([]);
  });
  it('does not strip explicitly authored lower-level SDK enum constraints', () => {
    expect(convertSchemaToOpenApi(leaf()).enum).toEqual(['alpha', 'beta']);
    const explicit = buildOpenApiDocument([endpoint('/alpha')]);
    expect(JSON.stringify(explicit)).toContain('"enum":["alpha","beta"]');
  });
  it('projects before discovery so now-equivalent learned contracts can share a model', () => {
    const a = endpoint('/alpha');
    const b = endpoint('/beta');
    b.requestSchema!.properties!.enum.enum = ['different'];
    const projected = prepareLearnedSchemasForExport([a, b]);
    const registry = discoverDomainModels(projected);
    const doc = buildOpenApiDocument(projected, {}, undefined, registry);
    expect(JSON.stringify(doc)).not.toContain('"enum":["alpha","beta"]');
    const paths = doc.paths as Record<
      string,
      { post: { requestBody: { content: Record<string, { schema: { $ref?: string } }> } } }
    >;
    expect(paths['/alpha'].post.requestBody.content['application/json'].schema.$ref).toBe(
      paths['/beta'].post.requestBody.content['application/json'].schema.$ref,
    );
    expect(a.requestSchema!.properties!.enum.enum).toEqual(['alpha', 'beta']);
    expect(b.requestSchema!.properties!.enum.enum).toEqual(['different']);
  });
  it('preserves semantic null-only OpenAPI3.0 encoding after projection', () => {
    const s = endpoint('/null');
    s.requestSchema = { type: 'null', stats: { ...stats } };
    const projected = prepareLearnedSchemasForExport([s]);
    const converted = convertToOpenApi30(buildOpenApiDocument(projected));
    expect(JSON.stringify(converted)).toContain('"enum":[null]');
  });
});
