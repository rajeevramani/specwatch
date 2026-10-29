/** Independent public-pipeline contracts; no production implementation reads. */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import { inferSchema } from '../../src/inference/engine.js';
import { runAggregation } from '../../src/aggregation/pipeline.js';
import { discoverDomainModels } from '../../src/export/domain-models.js';
import { buildOpenApiDocument, convertToOpenApi30 } from '../../src/export/openapi.js';

type Version = '3.1' | '3.0';
type Schema = Record<string, unknown>;
interface Document {
  openapi: string;
  components?: { schemas: Record<string, Schema> };
  paths: Record<
    string,
    {
      get: {
        responses: Record<
          string,
          {
            content: Record<string, { schema: Schema }>;
          }
        >;
      };
    }
  >;
}

function pipeline(bodies: unknown[], version: Version): Document {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const samples = new SampleRepository(db);
    const session = sessions.createSession('http://127.0.0.1:1', 1, 'null-code-contract');
    for (const body of bodies) {
      samples.insertSample({
        sessionId: session.id,
        httpMethod: 'GET',
        path: '/observations',
        normalizedPath: '/observations',
        statusCode: 200,
        responseSchema: inferSchema(body),
        capturedAt: '2026-10-28T00:00:00.000Z',
      });
      sessions.incrementSampleCount(session.id);
    }
    const schemas = runAggregation(db, session.id).schemas;
    expect(schemas).toHaveLength(1);
    expect(schemas[0].sampleCount).toBe(bodies.length);
    const registry = discoverDomainModels(schemas);
    const before = JSON.stringify({ schemas, registry });
    const document = buildOpenApiDocument(schemas, {}, undefined, registry);
    expect(JSON.stringify({ schemas, registry }), 'export input immutability').toBe(before);
    return exportVersion(document, version);
  } finally {
    db.close();
  }
}

function exportVersion(
  input: Parameters<typeof convertToOpenApi30>[0],
  version: Version,
): Document {
  const before = JSON.stringify(input);
  const result = version === '3.0' ? convertToOpenApi30(input) : input;
  expect(JSON.stringify(input), 'conversion input immutability').toBe(before);
  expect(result.openapi).toBe(version === '3.0' ? '3.0.3' : '3.1.0');
  return result as unknown as Document;
}

function validator(document: Document) {
  const ajv =
    document.openapi === '3.1.0' ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const before = JSON.stringify(document);
  const schema =
    document.paths['/observations'].get.responses['200'].content['application/json'].schema;
  // Preserve the exported constraints and full component-reference context.
  const validate = ajv.compile({ ...schema, components: document.components });
  expect(JSON.stringify(document), 'validator must not mutate generated document').toBe(before);
  return validate;
}

function check(document: Document, accepted: unknown[], rejected: unknown[]) {
  const validate = validator(document);
  for (const value of accepted) {
    expect
      .soft(validate(value), `accept ${JSON.stringify(value)}: ${JSON.stringify(validate.errors)}`)
      .toBe(true);
  }
  for (const value of rejected) {
    expect
      .soft(validate(value), `reject ${JSON.stringify(value)}: ${JSON.stringify(validate.errors)}`)
      .toBe(false);
  }
}

function enums(value: unknown): unknown[][] {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [
    ...(Array.isArray(node.enum) ? [node.enum] : []),
    ...Object.entries(node)
      .filter(([key]) => key !== 'enum')
      .flatMap(([, child]) => enums(child)),
  ];
}

const repeated = (values: unknown[], count = 40) =>
  Array.from({ length: count }, (_, index) => values[index % values.length]);

describe.each(['3.1', '3.0'] as const)('exact null and code semantics OAS %s', (version) => {
  it('keeps standalone observed null distinct from every non-null JSON category', () => {
    const document = pipeline(repeated([null]), version);
    check(document, [null], ['', 'unseen', 0, 1.5, true, false, {}, { value: null }, [], [null]]);
  });

  it('retains object/array/null alternatives without admitting unobserved primitives', () => {
    const object = { enabled: true };
    const array = [true];
    const document = pipeline(repeated([object, array, null]), version);
    check(document, [object, array, null], ['unseen', 7, false, { enabled: 'wrong' }, ['wrong']]);
  });

  it('retains nullable categorical labels without weakening a non-null enum usage', () => {
    const document = pipeline(
      Array.from({ length: 60 }, (_, index) => ({
        status: ['active', 'draft', null][index % 3],
        state: index % 2 ? 'active' : 'draft',
      })),
      version,
    );
    check(
      document,
      [
        { status: 'active', state: 'draft' },
        { status: 'draft', state: 'active' },
        { status: null, state: 'active' },
      ],
      [
        { status: 'unseen', state: 'active' },
        { status: 7, state: 'active' },
        { status: 'active', state: 'unseen' },
        { status: 'active', state: null },
      ],
    );
    expect(
      enums(document).some((values) => values.includes('active') && values.includes('draft')),
    ).toBe(true);
  });

  it.each(['CountryCode', 'currencyCode', 'errorCode'])(
    'exports alphabetic low-cardinality %s as an enum at ten samples',
    (field) => {
      const labels =
        field === 'CountryCode'
          ? ['AU', 'NZ']
          : field === 'currencyCode'
            ? ['AUD', 'NZD']
            : ['DENIED', 'MISSING'];
      const document = pipeline(
        repeated(labels, 10).map((value) => ({ [field]: value })),
        version,
      );
      check(
        document,
        labels.map((value) => ({ [field]: value })),
        [{ [field]: 'UNSEEN' }, { [field]: null }, { [field]: 7 }],
      );
      expect(enums(document)).toContainEqual(expect.arrayContaining(labels));
    },
  );

  it.each([
    { name: 'numeric statusCode', field: 'statusCode', values: [200, 404], unseen: 201, count: 40 },
    {
      name: 'numeric-looking code',
      field: 'countryCode',
      values: ['200', '404'],
      unseen: '201',
      count: 40,
    },
    {
      name: 'UUID-like code',
      field: 'errorCode',
      values: ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'],
      unseen: '550e8400-e29b-41d4-a716-446655440002',
      count: 40,
    },
    {
      name: 'too few samples',
      field: 'currencyCode',
      values: ['AUD', 'NZD'],
      unseen: 'USD',
      count: 9,
    },
    {
      name: 'more than ten categories',
      field: 'errorCode',
      values: [
        'ALPHA',
        'BRAVO',
        'CHARLIE',
        'DELTA',
        'ECHO',
        'FOXTROT',
        'GOLF',
        'HOTEL',
        'INDIA',
        'JULIET',
        'KILO',
      ],
      unseen: 'LIMA',
      count: 44,
    },
    {
      name: 'exact generic code guard',
      field: 'code',
      values: ['ALPHA', 'BRAVO'],
      unseen: 'CHARLIE',
      count: 40,
    },
  ])('does not infer an enum for $name', ({ field, values, unseen, count }) => {
    const document = pipeline(
      repeated(values, count).map((value) => ({ [field]: value })),
      version,
    );
    const wrongType = typeof values[0] === 'number' ? 'wrong' : 7;
    check(
      document,
      [...values, unseen].map((value) => ({ [field]: value })),
      [{ [field]: null }, { [field]: wrongType }],
    );
    expect(enums(document), 'no categorical constraint for excluded observations').toEqual([]);
    if (field === 'statusCode') {
      check(
        document,
        [{ statusCode: -(2 ** 31) }, { statusCode: 2 ** 31 - 1 }],
        [{ statusCode: -(2 ** 31) - 1 }, { statusCode: 2 ** 31 }, { statusCode: 1.5 }],
      );
    }
  });
});

// Narrower raw-document conversion boundary: inference cannot express these overlapping branches.
it('3.0 conversion preserves exclusive overlapping oneOf branches and annotated null exactly', () => {
  const raw = {
    openapi: '3.1.0',
    info: { title: 'exclusive conversion control', version: '1' },
    paths: {
      '/observations': {
        get: {
          responses: {
            '200': {
              description: 'control',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: { left: { type: 'boolean' } },
                        required: ['left'],
                      },
                      {
                        type: 'object',
                        properties: { right: { type: 'boolean' } },
                        required: ['right'],
                      },
                      { type: 'null', enum: [null], description: 'Only the observed null value' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  };
  const before = JSON.stringify(raw);
  for (const version of ['3.1', '3.0'] as const) {
    const document = exportVersion(raw as Parameters<typeof convertToOpenApi30>[0], version);
    check(
      document,
      [{ left: true }, { right: false }, null],
      [{ left: true, right: false }, {}, 'unseen', 7, false, [], { left: 'wrong' }],
    );
  }
  expect(JSON.stringify(raw), 'raw source remains immutable after conversion and validation').toBe(
    before,
  );
});
