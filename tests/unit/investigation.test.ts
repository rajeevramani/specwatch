import { describe, it, expect } from 'vitest';
import type { Sample, InferredSchema } from '../../src/inference/types.js';
import type { PhaseAnalysis } from '../../src/analysis/phases.js';
import type { RedundantCall } from '../../src/analysis/sequences.js';
import {
  schemasStructurallyEqual,
  classifyCause,
  investigateOperation,
  investigateRedundantCalls,
} from '../../src/analysis/investigation.js';
import type { CallOccurrence } from '../../src/analysis/investigation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema(props: Record<string, InferredSchema>): InferredSchema {
  return {
    type: 'object',
    properties: props,
    stats: { sampleCount: 1, presenceCount: 1, confidence: 1 },
  };
}

function stringSchema(): InferredSchema {
  return { type: 'string', stats: { sampleCount: 1, presenceCount: 1, confidence: 1 } };
}

function numberSchema(): InferredSchema {
  return { type: 'number', stats: { sampleCount: 1, presenceCount: 1, confidence: 1 } };
}

const schemaA = makeSchema({ id: stringSchema(), name: stringSchema() });
const schemaB = makeSchema({ id: stringSchema(), count: numberSchema() });

function isoTime(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

const BASE_TIME = new Date('2025-01-15T10:00:00Z').getTime();

function makeSample(overrides: Partial<Sample> & { id: number; sessionId: string }): Sample {
  return {
    httpMethod: 'POST',
    path: '/mcp',
    normalizedPath: '/mcp',
    capturedAt: isoTime(BASE_TIME, 0),
    ...overrides,
  };
}

function makeOccurrence(overrides: Partial<CallOccurrence>): CallOccurrence {
  return {
    sampleIndex: 0,
    sampleId: 1,
    capturedAt: isoTime(BASE_TIME, 0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schemasStructurallyEqual
// ---------------------------------------------------------------------------

describe('schemasStructurallyEqual', () => {
  it('returns true for identical schemas', () => {
    expect(schemasStructurallyEqual(schemaA, schemaA)).toBe(true);
  });

  it('returns true for structurally equal but separate schema objects', () => {
    const copy = makeSchema({ id: stringSchema(), name: stringSchema() });
    expect(schemasStructurallyEqual(schemaA, copy)).toBe(true);
  });

  it('returns false for different schemas', () => {
    expect(schemasStructurallyEqual(schemaA, schemaB)).toBe(false);
  });

  it('returns true when both are undefined', () => {
    expect(schemasStructurallyEqual(undefined, undefined)).toBe(true);
  });

  it('returns false when only first is undefined', () => {
    expect(schemasStructurallyEqual(undefined, schemaA)).toBe(false);
  });

  it('returns false when only second is undefined', () => {
    expect(schemasStructurallyEqual(schemaA, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyCause
// ---------------------------------------------------------------------------

describe('classifyCause', () => {
  it('returns retry_after_error when from has error status', () => {
    const from = makeOccurrence({ statusCode: 500, responseSchema: schemaA });
    const to = makeOccurrence({ statusCode: 200, responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 1000) });
    expect(classifyCause(from, to, [], false)).toBe('retry_after_error');
  });

  it('returns different_params when request schemas differ', () => {
    const from = makeOccurrence({ requestSchema: schemaA, responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 0) });
    const to = makeOccurrence({ requestSchema: schemaB, responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 1000) });
    expect(classifyCause(from, to, [], false)).toBe('different_params');
  });

  it('returns session_restart when deltaMs > 30000', () => {
    const from = makeOccurrence({ capturedAt: isoTime(BASE_TIME, 0), responseSchema: schemaA });
    const to = makeOccurrence({ capturedAt: isoTime(BASE_TIME, 60000), responseSchema: schemaA });
    expect(classifyCause(from, to, [], false)).toBe('session_restart');
  });

  it('returns different_phase when crossPhase is true', () => {
    const from = makeOccurrence({ phase: 'discovery', responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 0) });
    const to = makeOccurrence({ phase: 'creation', responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 1000) });
    expect(classifyCause(from, to, [], true)).toBe('different_phase');
  });

  it('returns different_response when response schemas differ', () => {
    const from = makeOccurrence({ responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 0) });
    const to = makeOccurrence({ responseSchema: schemaB, capturedAt: isoTime(BASE_TIME, 1000) });
    expect(classifyCause(from, to, [], false)).toBe('different_response');
  });

  it('returns identical_response when everything is the same', () => {
    const from = makeOccurrence({ responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 0) });
    const to = makeOccurrence({ responseSchema: schemaA, capturedAt: isoTime(BASE_TIME, 1000) });
    expect(classifyCause(from, to, [], false)).toBe('identical_response');
  });

  // Priority tests
  it('retry_after_error takes priority over different_params', () => {
    const from = makeOccurrence({
      statusCode: 400,
      requestSchema: schemaA,
      responseSchema: schemaA,
      capturedAt: isoTime(BASE_TIME, 0),
    });
    const to = makeOccurrence({
      requestSchema: schemaB,
      responseSchema: schemaB,
      capturedAt: isoTime(BASE_TIME, 1000),
    });
    expect(classifyCause(from, to, [], true)).toBe('retry_after_error');
  });

  it('different_params takes priority over session_restart', () => {
    const from = makeOccurrence({
      requestSchema: schemaA,
      responseSchema: schemaA,
      capturedAt: isoTime(BASE_TIME, 0),
    });
    const to = makeOccurrence({
      requestSchema: schemaB,
      responseSchema: schemaA,
      capturedAt: isoTime(BASE_TIME, 60000),
    });
    expect(classifyCause(from, to, [], true)).toBe('different_params');
  });

  it('session_restart takes priority over different_phase', () => {
    const from = makeOccurrence({
      phase: 'discovery',
      responseSchema: schemaA,
      capturedAt: isoTime(BASE_TIME, 0),
    });
    const to = makeOccurrence({
      phase: 'creation',
      responseSchema: schemaA,
      capturedAt: isoTime(BASE_TIME, 60000),
    });
    expect(classifyCause(from, to, [], true)).toBe('session_restart');
  });

  it('different_phase takes priority over different_response', () => {
    const from = makeOccurrence({
      phase: 'discovery',
      responseSchema: schemaA,
      capturedAt: isoTime(BASE_TIME, 0),
    });
    const to = makeOccurrence({
      phase: 'creation',
      responseSchema: schemaB,
      capturedAt: isoTime(BASE_TIME, 1000),
    });
    expect(classifyCause(from, to, [], true)).toBe('different_phase');
  });
});

// ---------------------------------------------------------------------------
// investigateOperation
// ---------------------------------------------------------------------------

describe('investigateOperation', () => {
  it('investigates a simple redundant tools/list scenario', () => {
    const samples: Sample[] = [
      makeSample({
        id: 1,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 0),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 2,
        sessionId: 's1',
        jsonrpcMethod: 'tools/call',
        jsonrpcTool: 'create_thing',
        capturedAt: isoTime(BASE_TIME, 500),
        statusCode: 200,
      }),
      makeSample({
        id: 3,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 1000),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 4,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 2000),
        statusCode: 200,
        responseSchema: schemaA,
      }),
    ];

    const result = investigateOperation(samples, 'tools/list');

    expect(result.operationKey).toBe('tools/list');
    expect(result.occurrences).toHaveLength(3);
    expect(result.pairAnalyses).toHaveLength(2);
    expect(result.primaryCause).toBe('identical_response');
    expect(result.explanation).toContain('create_thing');
    expect(result.explanation).toContain('unchanged');
    expect(result.recommendation).toContain('Cache');
  });

  it('identifies intervening operations between calls', () => {
    const samples: Sample[] = [
      makeSample({
        id: 1,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 0),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 2,
        sessionId: 's1',
        jsonrpcMethod: 'tools/call',
        jsonrpcTool: 'create_thing',
        capturedAt: isoTime(BASE_TIME, 500),
        statusCode: 200,
      }),
      makeSample({
        id: 3,
        sessionId: 's1',
        jsonrpcMethod: 'tools/call',
        jsonrpcTool: 'query_thing',
        capturedAt: isoTime(BASE_TIME, 800),
        statusCode: 200,
      }),
      makeSample({
        id: 4,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 1200),
        statusCode: 200,
        responseSchema: schemaA,
      }),
    ];

    const result = investigateOperation(samples, 'tools/list');
    expect(result.pairAnalyses[0].interveningOps).toEqual([
      'tools/call:create_thing',
      'tools/call:query_thing',
    ]);
  });

  it('detects retry_after_error as primary cause', () => {
    const samples: Sample[] = [
      makeSample({
        id: 1,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 0),
        statusCode: 500,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 2,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 1000),
        statusCode: 200,
        responseSchema: schemaA,
      }),
    ];

    const result = investigateOperation(samples, 'tools/list');
    expect(result.primaryCause).toBe('retry_after_error');
    expect(result.explanation).toContain('500');
    expect(result.explanation).toContain('retried');
  });

  it('uses phaseAnalysis when provided', () => {
    const samples: Sample[] = [
      makeSample({
        id: 1,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 0),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 2,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 1000),
        statusCode: 200,
        responseSchema: schemaA,
      }),
    ];

    const phaseAnalysis: PhaseAnalysis = {
      phases: [
        {
          name: 'discovery',
          startIndex: 0,
          endIndex: 0,
          samples: [],
          duration: 0,
        },
        {
          name: 'creation',
          startIndex: 1,
          endIndex: 1,
          samples: [],
          duration: 0,
        },
      ],
      toolPhaseMap: new Map(),
    };

    const result = investigateOperation(samples, 'tools/list', phaseAnalysis);
    expect(result.occurrences[0].phase).toBe('discovery');
    expect(result.occurrences[1].phase).toBe('creation');
    expect(result.primaryCause).toBe('different_phase');
  });

  it('returns unknown for empty matches', () => {
    const samples: Sample[] = [
      makeSample({
        id: 1,
        sessionId: 's1',
        jsonrpcMethod: 'initialize',
        capturedAt: isoTime(BASE_TIME, 0),
        statusCode: 200,
      }),
    ];

    const result = investigateOperation(samples, 'tools/list');
    expect(result.occurrences).toHaveLength(0);
    expect(result.pairAnalyses).toHaveLength(0);
    expect(result.primaryCause).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// investigateRedundantCalls
// ---------------------------------------------------------------------------

describe('investigateRedundantCalls', () => {
  it('investigates multiple redundant operations', () => {
    const samples: Sample[] = [
      makeSample({
        id: 1,
        sessionId: 's1',
        jsonrpcMethod: 'initialize',
        capturedAt: isoTime(BASE_TIME, 0),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 2,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 500),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 3,
        sessionId: 's1',
        jsonrpcMethod: 'initialize',
        capturedAt: isoTime(BASE_TIME, 1000),
        statusCode: 200,
        responseSchema: schemaA,
      }),
      makeSample({
        id: 4,
        sessionId: 's1',
        jsonrpcMethod: 'tools/list',
        capturedAt: isoTime(BASE_TIME, 1500),
        statusCode: 200,
        responseSchema: schemaA,
      }),
    ];

    const redundantCalls: RedundantCall[] = [
      { operationKey: 'initialize', count: 2, expectedCount: 1 },
      { operationKey: 'tools/list', count: 2, expectedCount: 1 },
    ];

    const report = investigateRedundantCalls(samples, redundantCalls);

    expect(report.sessionId).toBe('s1');
    expect(report.investigations).toHaveLength(2);
    expect(report.investigations[0].operationKey).toBe('initialize');
    expect(report.investigations[1].operationKey).toBe('tools/list');
    expect(report.investigations[0].primaryCause).toBe('identical_response');
    expect(report.investigations[1].primaryCause).toBe('identical_response');
  });

  it('returns empty investigations for empty redundantCalls', () => {
    const samples: Sample[] = [
      makeSample({ id: 1, sessionId: 's1', capturedAt: isoTime(BASE_TIME, 0) }),
    ];

    const report = investigateRedundantCalls(samples, []);
    expect(report.investigations).toHaveLength(0);
  });

  it('returns empty sessionId for empty samples', () => {
    const report = investigateRedundantCalls([], [
      { operationKey: 'tools/list', count: 2, expectedCount: 1 },
    ]);
    expect(report.sessionId).toBe('');
    expect(report.investigations).toHaveLength(1);
    expect(report.investigations[0].occurrences).toHaveLength(0);
  });
});
