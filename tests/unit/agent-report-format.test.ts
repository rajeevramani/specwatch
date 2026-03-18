import { describe, it, expect } from 'vitest';
import { formatAgentReport } from '../../src/cli/output.js';
import type { SequenceAnalysis, OperationSequence } from '../../src/analysis/sequences.js';
import type { CompletenessReport, ResponseCompleteness } from '../../src/analysis/completeness.js';

function makeLoop(overrides: Partial<OperationSequence> = {}): OperationSequence {
  return {
    fromMethod: 'POST',
    fromPath: '/users',
    toMethod: 'GET',
    toPath: '/users/{userId}',
    avgDelayMs: 120,
    count: 5,
    pattern: 'verification_loop',
    ...overrides,
  };
}

function makeThinEndpoint(overrides: Partial<ResponseCompleteness> = {}): ResponseCompleteness {
  return {
    method: 'POST',
    path: '/users',
    writeFieldCount: 2,
    readFieldCount: 10,
    completenessScore: 0.2,
    missingFields: ['email', 'name', 'phone', 'address'],
    ...overrides,
  };
}

describe('formatAgentReport', () => {
  it('formats report with verification loops', () => {
    const analysis: SequenceAnalysis = {
      sequences: [makeLoop()],
      verificationLoops: [makeLoop()],
      totalRequests: 20,
      wastedRequests: 5,
    };
    const completeness: CompletenessReport = {
      endpoints: [makeThinEndpoint({ completenessScore: 0.8, writeFieldCount: 8, readFieldCount: 10, missingFields: ['phone', 'address'] })],
      thinResponses: [],
      avgCompleteness: 0.8,
    };

    const output = formatAgentReport('my-api', analysis, completeness, 50);

    expect(output).toContain('Agent-Friendliness Report: my-api (50 samples, 1 endpoint');
    expect(output).toContain('VERIFICATION LOOPS');
    expect(output).toContain('POST /users → GET /users/{userId}');
    expect(output).toContain('5 occurrences, avg 120ms delay');
    expect(output).toContain('→ Enrich POST response to eliminate redundant GET');
    expect(output).toContain('All write responses return adequate data.');
  });

  it('formats report with thin responses', () => {
    const analysis: SequenceAnalysis = {
      sequences: [],
      verificationLoops: [],
      totalRequests: 10,
      wastedRequests: 0,
    };
    const thin = makeThinEndpoint({ completenessScore: 0.2, writeFieldCount: 2, readFieldCount: 10 });
    const completeness: CompletenessReport = {
      endpoints: [thin],
      thinResponses: [thin],
      avgCompleteness: 0.2,
    };

    const output = formatAgentReport('my-api', analysis, completeness, 30);

    expect(output).toContain('THIN RESPONSES');
    expect(output).toContain('POST /users — 20% complete (2 of 10 fields)');
    expect(output).toContain('Missing: email, name, phone, address');
    expect(output).toContain('No verification loops detected.');
  });

  it('shows "no loops" and "adequate data" when no issues found', () => {
    const analysis: SequenceAnalysis = {
      sequences: [],
      verificationLoops: [],
      totalRequests: 10,
      wastedRequests: 0,
    };
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('clean-api', analysis, completeness, 15);

    expect(output).toContain('No verification loops detected.');
    expect(output).toContain('All write responses return adequate data.');
  });

  it('calculates summary percentages correctly', () => {
    const analysis: SequenceAnalysis = {
      sequences: [],
      verificationLoops: [makeLoop({ count: 8 })],
      totalRequests: 40,
      wastedRequests: 8,
    };
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0.75,
    };

    const output = formatAgentReport('test-api', analysis, completeness, 100);

    expect(output).toContain('SUMMARY');
    expect(output).toContain('Wasted requests: 8 of 40 (20%)');
    expect(output).toContain('Avg response completeness: 0.75');
  });

  it('truncates missing fields when more than 5', () => {
    const thin = makeThinEndpoint({
      missingFields: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    const analysis: SequenceAnalysis = {
      sequences: [],
      verificationLoops: [],
      totalRequests: 5,
      wastedRequests: 0,
    };
    const completeness: CompletenessReport = {
      endpoints: [thin],
      thinResponses: [thin],
      avgCompleteness: 0.2,
    };

    const output = formatAgentReport('big-api', analysis, completeness, 20);

    expect(output).toContain('Missing: a, b, c, d, e, ... and 3 more');
    expect(output).not.toContain(', f,');
    expect(output).not.toContain(', g,');
    expect(output).not.toContain(', h');
  });

  it('sorts verification loops by count descending', () => {
    const loopA = makeLoop({ fromPath: '/orders', toPath: '/orders/{orderId}', count: 2 });
    const loopB = makeLoop({ fromPath: '/users', toPath: '/users/{userId}', count: 10 });
    const analysis: SequenceAnalysis = {
      sequences: [loopA, loopB],
      verificationLoops: [loopA, loopB],
      totalRequests: 50,
      wastedRequests: 12,
    };
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 1.0,
    };

    const output = formatAgentReport('test', analysis, completeness, 50);

    const usersIdx = output.indexOf('/users/{userId}');
    const ordersIdx = output.indexOf('/orders/{orderId}');
    expect(usersIdx).toBeLessThan(ordersIdx);
  });

  it('sorts thin responses by score ascending', () => {
    const thinA = makeThinEndpoint({ path: '/orders', completenessScore: 0.4 });
    const thinB = makeThinEndpoint({ path: '/users', completenessScore: 0.1 });
    const analysis: SequenceAnalysis = {
      sequences: [],
      verificationLoops: [],
      totalRequests: 10,
      wastedRequests: 0,
    };
    const completeness: CompletenessReport = {
      endpoints: [thinA, thinB],
      thinResponses: [thinA, thinB],
      avgCompleteness: 0.25,
    };

    const output = formatAgentReport('test', analysis, completeness, 30);

    const usersIdx = output.indexOf('POST /users');
    const ordersIdx = output.indexOf('POST /orders');
    expect(usersIdx).toBeLessThan(ordersIdx);
  });

  it('formats JSON-RPC verification loops with tool names', () => {
    const loop: OperationSequence = {
      fromMethod: 'tools/call',
      fromPath: 'tools/call:create_cluster',
      toMethod: 'tools/call',
      toPath: 'tools/call:get_cluster',
      avgDelayMs: 600,
      count: 8,
      pattern: 'verification_loop',
    };
    const analysis: SequenceAnalysis = {
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 30,
      wastedRequests: 8,
    };
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 30);

    expect(output).toContain('tools/call:create_cluster → tools/call:get_cluster');
    expect(output).toContain('8 occurrences, avg 600ms delay');
    expect(output).toContain('→ Enrich write tool response to eliminate redundant read');
    // Should NOT show HTTP method format
    expect(output).not.toContain('POST tools/call');
  });

  it('formats JSON-RPC retry pattern', () => {
    const loop: OperationSequence = {
      fromMethod: 'tools/call',
      fromPath: 'tools/call:create_cluster',
      toMethod: 'tools/call',
      toPath: 'tools/call:create_cluster',
      avgDelayMs: 200,
      count: 3,
      pattern: 'retry',
    };
    const analysis: SequenceAnalysis = {
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 10,
      wastedRequests: 3,
    };
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);
    expect(output).toContain('→ Tool is being retried — check error handling');
  });

  it('formats JSON-RPC thin responses with tool names', () => {
    const thin: ResponseCompleteness = {
      method: 'tools/call',
      path: 'tools/call:create_cluster',
      writeFieldCount: 2,
      readFieldCount: 10,
      completenessScore: 0.2,
      missingFields: ['status', 'region', 'ports'],
    };
    const analysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'tools/call',
          fromPath: 'tools/call:create_cluster',
          toMethod: 'tools/call',
          toPath: 'tools/call:get_cluster',
          avgDelayMs: 100,
          count: 1,
          pattern: 'verification_loop',
        },
      ],
      verificationLoops: [],
      totalRequests: 5,
      wastedRequests: 0,
    };
    const completeness: CompletenessReport = {
      endpoints: [thin],
      thinResponses: [thin],
      avgCompleteness: 0.2,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 15);

    // JSON-RPC thin responses: shows just tool name, not full operation key
    expect(output).toContain('create_cluster — 20% complete (2 of 10 fields)');
    expect(output).toContain('Missing: status, region, ports');
    // Should NOT show "tools/call create_cluster" or "tools/call:create_cluster —"
    expect(output).not.toContain('tools/call:create_cluster —');
  });

  it('uses "tools" label instead of "endpoints" for JSON-RPC', () => {
    const analysis: SequenceAnalysis = {
      sequences: [
        {
          fromMethod: 'tools/call',
          fromPath: 'tools/call:create_item',
          toMethod: 'tools/call',
          toPath: 'tools/call:get_item',
          avgDelayMs: 100,
          count: 1,
          pattern: 'verification_loop',
        },
      ],
      verificationLoops: [],
      totalRequests: 5,
      wastedRequests: 0,
    };
    const completeness: CompletenessReport = {
      endpoints: [
        {
          method: 'tools/call',
          path: 'tools/call:create_item',
          writeFieldCount: 3,
          readFieldCount: 6,
          completenessScore: 0.5,
          missingFields: ['a', 'b', 'c'],
        },
      ],
      thinResponses: [],
      avgCompleteness: 0.5,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 20);
    expect(output).toContain('1 tools)');
    expect(output).not.toContain('1 endpoints)');
  });

  it('formats JSON-RPC redundant_list pattern', () => {
    const loop: OperationSequence = {
      fromMethod: 'tools/call',
      fromPath: 'tools/list',
      toMethod: 'tools/call',
      toPath: 'tools/list',
      avgDelayMs: 50,
      count: 4,
      pattern: 'redundant_list',
    };
    const analysis: SequenceAnalysis = {
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 10,
      wastedRequests: 4,
    };
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);
    expect(output).toContain('→ Cache tool list to avoid redundant calls');
  });
});
