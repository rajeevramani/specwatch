/**
 * Unit tests for the pinned snake_case `investigate --json` contract
 * (schema specwatch.investigation.v1). Asserts stable field names, diff mapping,
 * and null-handling so the machine contract can't silently drift.
 */

import { describe, it, expect } from 'vitest';
import {
  INVESTIGATION_JSON_SCHEMA_VERSION,
  serializeInvestigationEntry,
  serializeInvestigationReport,
  serializeSingleInvestigation,
} from '../../src/analysis/investigation-json.js';
import type { CallInvestigation, InvestigationReport } from '../../src/analysis/investigation.js';
import type { SchemaDiff } from '../../src/types/index.js';

const diff: SchemaDiff = {
  breakingChanges: [
    {
      type: 'required_field_removed',
      path: '$.user.email',
      description: 'email removed',
      oldValue: 'string',
      newValue: undefined,
    },
  ],
  nonBreakingChanges: ['added $.user.nickname'],
};

function makeInvestigation(): CallInvestigation {
  return {
    operationKey: 'GET /users/{userId}',
    primaryCause: 'identical_response',
    explanation: 'Called twice with the same response',
    recommendation: 'Cache the first response',
    occurrences: [
      {
        sampleIndex: 0,
        sampleId: 10,
        capturedAt: '2026-07-09T00:00:00Z',
        statusCode: 200,
        phase: 'exploration',
      },
      { sampleIndex: 3, sampleId: 13, capturedAt: '2026-07-09T00:00:05Z' }, // no status/phase
    ],
    pairAnalyses: [
      {
        fromIndex: 0,
        toIndex: 3,
        deltaMs: 5000,
        cause: 'identical_response',
        responseDiff: diff,
        requestDiff: undefined,
        interveningOps: ['POST /logs'],
        crossPhase: false,
      },
    ],
  };
}

describe('investigation-json contract', () => {
  it('serializes an entry with pinned snake_case keys', () => {
    const e = serializeInvestigationEntry(makeInvestigation());
    expect(e.operation_key).toBe('GET /users/{userId}');
    expect(e.primary_cause).toBe('identical_response');
    expect(e.explanation).toBe('Called twice with the same response');
    expect(e.recommendation).toBe('Cache the first response');
    // no camelCase leakage from the internal type
    expect(Object.keys(e)).not.toContain('operationKey');
    expect(Object.keys(e)).not.toContain('primaryCause');
    expect(Object.keys(e)).not.toContain('pairAnalyses');
    expect(Object.keys(e)).toContain('pair_analyses');
  });

  it('maps occurrences with null for absent status/phase', () => {
    const e = serializeInvestigationEntry(makeInvestigation());
    expect(e.occurrences[0]).toEqual({
      sample_index: 0,
      sample_id: 10,
      captured_at: '2026-07-09T00:00:00Z',
      status_code: 200,
      phase: 'exploration',
    });
    expect(e.occurrences[1].status_code).toBeNull();
    expect(e.occurrences[1].phase).toBeNull();
  });

  it('maps pair diffs into a snake_case diff shape and null when absent', () => {
    const e = serializeInvestigationEntry(makeInvestigation());
    const pair = e.pair_analyses[0];
    expect(pair.from_index).toBe(0);
    expect(pair.to_index).toBe(3);
    expect(pair.delta_ms).toBe(5000);
    expect(pair.intervening_ops).toEqual(['POST /logs']);
    expect(pair.cross_phase).toBe(false);
    expect(pair.request_diff).toBeNull();
    expect(pair.response_diff).toEqual({
      breaking_changes: [
        {
          type: 'required_field_removed',
          path: '$.user.email',
          description: 'email removed',
          old_value: 'string',
          new_value: null,
        },
      ],
      non_breaking_changes: ['added $.user.nickname'],
    });
  });

  it('report serialization carries schema_version + session_id and is JSON-round-trippable', () => {
    const report: InvestigationReport = {
      sessionId: 'sess-123',
      investigations: [makeInvestigation()],
    };
    const json = serializeInvestigationReport(report);
    expect(json.schema_version).toBe(INVESTIGATION_JSON_SCHEMA_VERSION);
    expect(json.schema_version).toBe('specwatch.investigation.v1');
    expect(json.session_id).toBe('sess-123');
    expect(json.investigations).toHaveLength(1);
    // fully serializable with no undefined/circular structures
    expect(() => JSON.parse(JSON.stringify(json))).not.toThrow();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('single-investigation serialization wraps one entry under the given session id', () => {
    const json = serializeSingleInvestigation('sess-9', makeInvestigation());
    expect(json.session_id).toBe('sess-9');
    expect(json.investigations).toHaveLength(1);
    expect(json.investigations[0].operation_key).toBe('GET /users/{userId}');
  });

  it('empty report still produces a valid parseable contract', () => {
    const json = serializeInvestigationReport({ sessionId: 'sess-0', investigations: [] });
    expect(json.investigations).toEqual([]);
    expect(json.schema_version).toBe('specwatch.investigation.v1');
    expect(() => JSON.parse(JSON.stringify(json))).not.toThrow();
  });
});
