import { describe, expect, it } from 'vitest';
import { collectOpenApiOperations, matchOpenApiOperation } from '../../src/analysis/spec-mapper.js';
import { buildAgentEvidence } from '../../src/analysis/agent-evidence.js';
import { detectSequences } from '../../src/analysis/sequences.js';
import { getDatabase } from '../../src/storage/database.js';
import { SessionRepository } from '../../src/storage/sessions.js';
import { SampleRepository } from '../../src/storage/samples.js';
import type { Sample } from '../../src/types/index.js';

type EvidenceOptions = Parameters<typeof buildAgentEvidence>[0];
type Analysis = EvidenceOptions['sequenceAnalysis'];
type Endpoint = EvidenceOptions['completenessReport']['endpoints'][number];

const endpoint = (method: string, path: string): Endpoint => ({
  method,
  path,
  writeFieldCount: 1,
  readFieldCount: 2,
  completenessScore: 0.5,
  missingFields: ['name'],
});
const emptyAnalysis = (): Analysis => ({
  sequences: [],
  verificationLoops: [],
  totalRequests: 0,
  wastedRequests: 0,
  redundantCalls: [],
  toolUsage: [],
});
function evidence(analysis: Analysis, endpoints: Endpoint[], isJsonRpc = false) {
  return buildAgentEvidence({
    runName: 'correctness',
    sampleCount: analysis.totalRequests,
    sequenceAnalysis: analysis,
    completenessReport: { endpoints, thinResponses: [], avgCompleteness: 0.5 },
    isJsonRpc,
  });
}
function transition(
  fromMethod: string,
  fromPath: string,
  toMethod: string,
  toPath: string,
  count: number,
  pattern: Analysis['sequences'][number]['pattern'] = 'unknown',
): Analysis['sequences'][number] {
  return { fromMethod, fromPath, toMethod, toPath, count, pattern, avgDelayMs: 100 };
}

describe('sound OpenAPI matching', () => {
  it('never specializes an observed parameter into a spec literal', () => {
    const operations = collectOpenApiOperations({
      paths: {
        '/users/me': { get: { operationId: 'current' } },
        '/users/{accountId}': { get: { operationId: 'user' } },
      },
    });
    expect(matchOpenApiOperation(operations, 'GET', '/users/{userId}').operation?.operationId).toBe(
      'user',
    );
    const literalsOnly = collectOpenApiOperations({ paths: { '/users/me': { get: {} } } });
    expect(matchOpenApiOperation(literalsOnly, 'GET', '/users/{userId}').operation).toBeUndefined();
  });

  it('prefers concrete exact matches, then the uniquely most-literal compatible template', () => {
    const operations = collectOpenApiOperations({
      paths: {
        '/users/me': { get: { operationId: 'current' } },
        '/users/{id}': { get: { operationId: 'user' } },
        '/{collection}/{id}': { get: { operationId: 'generic' } },
      },
    });
    expect(matchOpenApiOperation(operations, 'GET', '/users/me').operation?.operationId).toBe(
      'current',
    );
    expect(matchOpenApiOperation(operations, 'GET', '/users/42').operation?.operationId).toBe(
      'user',
    );
    expect(matchOpenApiOperation(operations, 'GET', '/users/{userId}').operation?.operationId).toBe(
      'user',
    );
    expect(matchOpenApiOperation(operations, 'POST', '/users/42').operation).toBeUndefined();
    expect(matchOpenApiOperation(operations, 'GET', '/users/42/details').operation).toBeUndefined();
  });

  it('leaves equally specific compatible templates ambiguous', () => {
    const operations = collectOpenApiOperations({
      paths: {
        '/users/{id}': { get: {} },
        '/users/{slug}': { get: {} },
      },
    });
    const match = matchOpenApiOperation(operations, 'GET', '/users/42');
    expect(match.operation).toBeUndefined();
    expect(match.ambiguous).toBe(true);
    expect(match.warning).toMatch(/ambiguous/i);
  });
});

describe('report-time operation canonicalization', () => {
  it('folds multiple usage and sequence aliases onto completeness endpoints without losing counts', () => {
    const analysis = emptyAnalysis();
    analysis.totalRequests = 18;
    analysis.toolUsage = [
      { operationKey: 'PATCH /users/{id}', count: 2, isRedundant: false },
      { operationKey: 'PATCH /users/{personId}', count: 3, isRedundant: false },
      { operationKey: 'GET /users/{id}', count: 6, isRedundant: false },
      { operationKey: 'GET /users/{personId}', count: 7, isRedundant: false },
    ];
    analysis.sequences = [
      transition('PATCH', '/users/{id}', 'GET', '/users/{id}', 2, 'verification_loop'),
      transition('PATCH', '/users/{personId}', 'GET', '/users/{personId}', 3, 'verification_loop'),
      transition('GET', '/users/{id}', 'GET', '/users/{personId}', 4, 'retry'),
    ];
    analysis.verificationLoops = analysis.sequences.slice(0, 2);
    analysis.wastedRequests = 9;
    const report = evidence(analysis, [
      endpoint('PATCH', '/users/{userId}'),
      endpoint('GET', '/users/{userId}'),
    ]);
    expect(report.operations.map((op) => op.operation_key).sort()).toEqual([
      'GET /users/{userId}',
      'PATCH /users/{userId}',
    ]);
    const patch = report.operations.find((op) => op.method === 'PATCH');
    expect(patch).toMatchObject({
      observed_count: 5,
      response_completeness: 0.5,
      missing_response_fields: ['name'],
      verification_loop_count: 5,
      common_follow_up_operations: [{ operation: 'GET /users/{userId}', count: 5 }],
    });
    const get = report.operations.find((op) => op.method === 'GET');
    expect(get).toMatchObject({
      observed_count: 13,
      wasted_request_count: 4,
      common_follow_up_operations: [],
    });
    expect(report.operations.reduce((sum, op) => sum + op.observed_count, 0)).toBe(18);
  });

  it('keeps genuinely tied aliases original with a warning', () => {
    const analysis = emptyAnalysis();
    analysis.toolUsage = [{ operationKey: 'GET /users/{observed}', count: 3, isRedundant: false }];
    const report = evidence(analysis, [
      endpoint('GET', '/users/{id}'),
      endpoint('GET', '/users/{slug}'),
    ]);
    const original = report.operations.find((op) => op.operation_key === 'GET /users/{observed}');
    expect(original?.observed_count).toBe(3);
    expect(original?.warnings?.join(' ') ?? '').toMatch(/ambiguous/i);
    expect(report.operations.filter((op) => op.observed_count > 0)).toHaveLength(1);
  });

  it('keeps unmatched and different-method observations separate; a literal exact endpoint wins', () => {
    const analysis = emptyAnalysis();
    analysis.toolUsage = [
      { operationKey: 'GET /users/me', count: 2, isRedundant: false },
      { operationKey: 'DELETE /users/{observed}', count: 3, isRedundant: false },
      { operationKey: 'GET /elsewhere', count: 4, isRedundant: false },
      { operationKey: 'GET /users/{observed}', count: 5, isRedundant: false },
    ];
    const report = evidence(analysis, [
      endpoint('GET', '/users/me'),
      endpoint('GET', '/users/{userId}'),
    ]);
    const counts = Object.fromEntries(
      report.operations.map((op) => [op.operation_key, op.observed_count]),
    );
    expect(counts).toEqual({
      'GET /users/me': 2,
      'GET /users/{userId}': 5,
      'DELETE /users/{observed}': 3,
      'GET /elsewhere': 4,
    });
  });

  it('does not canonicalize JSON-RPC into REST evidence', () => {
    const analysis = emptyAnalysis();
    analysis.toolUsage = [{ operationKey: 'tools/call:get_user', count: 2, isRedundant: false }];
    analysis.sequences = [
      transition(
        'tools/call',
        'tools/call:get_user',
        'tools/call',
        'tools/call:get_user',
        1,
        'retry',
      ),
    ];
    const report = evidence(analysis, [endpoint('tools/call', 'tools/call:get_user')], true);
    expect(report.operations).toEqual([]);
    expect(report.warnings?.length).toBeGreaterThan(0);
  });
});

type Capture = Pick<Sample, 'httpMethod' | 'path' | 'normalizedPath'> &
  Partial<Pick<Sample, 'queryParams' | 'jsonrpcMethod' | 'jsonrpcTool'>> & { delay?: number };
function analyze(captures: Capture[]) {
  const db = getDatabase(':memory:');
  try {
    const sessions = new SessionRepository(db);
    const session = sessions.createSession(
      'https://example.test',
      8080,
      'correctness',
      undefined,
      'agent',
    );
    const samples = new SampleRepository(db);
    let offset = 0;
    for (const { delay = 100, ...capture } of captures) {
      offset += delay;
      samples.insertSample({
        ...capture,
        sessionId: session.id,
        statusCode: 200,
        capturedAt: new Date(Date.UTC(2026, 0, 1) + offset).toISOString(),
      });
      sessions.incrementSampleCount(session.id);
    }
    return detectSequences(db, session.id);
  } finally {
    db.close();
  }
}
const read = (path = '/users/42', queryParams?: Record<string, string>): Capture => ({
  httpMethod: 'GET',
  path,
  normalizedPath: '/users/{userId}',
  queryParams,
});
function assertPublicSequences(analysis: Analysis) {
  for (const sequence of analysis.sequences) {
    expect(Object.keys(sequence).sort()).toEqual([
      'avgDelayMs',
      'count',
      'fromMethod',
      'fromPath',
      'pattern',
      'toMethod',
      'toPath',
    ]);
    expect(sequence.fromPath).not.toContain('?');
    expect(sequence.toPath).not.toContain('?');
  }
}

describe('captured request equivalence in real SQLite sequences', () => {
  it.each([
    {
      name: 'equal maps in different key order',
      left: read('/users/42', { page: '1', token: 'private-query' }),
      right: read('/users/42', { token: 'private-query', page: '1' }),
      pattern: 'retry',
    },
    {
      name: 'undefined and empty map',
      left: read(),
      right: read('/users/42', {}),
      pattern: 'retry',
    },
    {
      name: 'different query values',
      left: read('/users/42', { page: '1' }),
      right: read('/users/42', { page: '2' }),
      pattern: 'unknown',
    },
    {
      name: 'missing key versus empty string',
      left: read('/users/42', {}),
      right: read('/users/42', { page: '' }),
      pattern: 'unknown',
    },
    {
      name: 'different key sets',
      left: read('/users/42', { page: '1' }),
      right: read('/users/42', { cursor: '1' }),
      pattern: 'unknown',
    },
    {
      name: 'exact string values, not numeric coercion',
      left: read('/users/42', { page: '01' }),
      right: read('/users/42', { page: '1' }),
      pattern: 'unknown',
    },
    {
      name: 'different concrete resources',
      left: read('/users/42'),
      right: read('/users/43'),
      pattern: 'unknown',
    },
  ])('$name', ({ left, right, pattern }) => {
    const analysis = analyze([left, right]);
    expect(analysis.sequences).toHaveLength(1);
    expect(analysis.sequences[0]).toMatchObject({
      pattern,
      count: 1,
      fromPath: '/users/{userId}',
      toPath: '/users/{userId}',
    });
    expect(analysis.totalRequests).toBe(2);
    expect(analysis.toolUsage.reduce((sum, usage) => sum + usage.count, 0)).toBe(2);
    expect(analysis.wastedRequests).toBe(pattern === 'retry' ? 1 : 0);
    assertPublicSequences(analysis);
    const report = evidence(analysis, []);
    expect(JSON.stringify({ sequences: analysis.sequences, report })).not.toContain(
      'private-query',
    );
    expect(report.operations[0]?.wasted_request_count).toBe(pattern === 'retry' ? 1 : 0);
  });

  it.each(['query', 'resource'])(
    'separates %s equivalence before averaging and counting',
    (kind) => {
      const first = read('/users/42', { page: 'private-query' });
      const changed =
        kind === 'query'
          ? read('/users/42', { page: 'other-query' })
          : read('/users/43', { page: 'private-query' });
      const analysis = analyze([
        first,
        { ...first, delay: 40 },
        { ...changed, delay: 200 },
        { ...first, delay: 400 },
      ]);
      const retry = analysis.sequences.filter((s) => s.pattern === 'retry');
      const unknown = analysis.sequences.filter((s) => s.pattern === 'unknown');
      expect(retry.reduce((sum, s) => sum + s.count, 0)).toBe(1);
      expect(retry[0]?.avgDelayMs).toBe(40);
      expect(unknown.reduce((sum, s) => sum + s.count, 0)).toBe(2);
      expect(unknown.reduce((sum, s) => sum + s.count * s.avgDelayMs, 0)).toBe(600);
      expect(analysis.totalRequests).toBe(4);
      expect(analysis.wastedRequests).toBe(1);
      expect(analysis.toolUsage.reduce((sum, usage) => sum + usage.count, 0)).toBe(4);
      assertPublicSequences(analysis);
      const report = evidence(analysis, []);
      expect(report.operations[0]).toMatchObject({ observed_count: 4, wasted_request_count: 1 });
      expect(JSON.stringify({ sequences: analysis.sequences, report })).not.toMatch(
        /private-query|other-query/,
      );
    },
  );

  it('preserves write-to-read verification and does not infer write retries', () => {
    const write: Capture = {
      httpMethod: 'PATCH',
      path: '/users/42',
      normalizedPath: '/users/{userId}',
    };
    const verification = analyze([write, read('/users/42', { view: 'full' })]);
    expect(verification.sequences[0]?.pattern).toBe('verification_loop');
    expect(verification.verificationLoops[0]?.count).toBe(1);
    expect(verification.wastedRequests).toBe(1);
    const writes = analyze([write, write]);
    expect(writes.sequences[0]?.pattern).toBe('unknown');
    expect(writes.wastedRequests).toBe(0);
  });

  it('preserves windowed JSON-RPC retry counts and REST-only evidence', () => {
    const call: Capture = {
      httpMethod: 'POST',
      path: '/rpc',
      normalizedPath: '/rpc',
      jsonrpcMethod: 'tools/call',
      jsonrpcTool: 'create_user',
    };
    const analysis = analyze([call, call, call]);
    expect(analysis.sequences.find((s) => s.pattern === 'retry')?.count).toBe(3);
    expect(analysis.toolUsage).toEqual([
      { operationKey: 'tools/call:create_user', count: 3, isRedundant: false },
    ]);
    expect(evidence(analysis, [], true).operations).toEqual([]);
  });
});
