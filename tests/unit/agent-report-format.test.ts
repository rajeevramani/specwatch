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

function makeAnalysis(overrides: Partial<SequenceAnalysis> = {}): SequenceAnalysis {
  return {
    sequences: [],
    verificationLoops: [],
    totalRequests: 10,
    wastedRequests: 0,
    redundantCalls: [],
    toolUsage: [],
    ...overrides,
  };
}

describe('formatAgentReport', () => {
  it('formats report with verification loops', () => {
    const analysis = makeAnalysis({
      sequences: [makeLoop()],
      verificationLoops: [makeLoop()],
      totalRequests: 20,
      wastedRequests: 5,
    });
    const completeness: CompletenessReport = {
      endpoints: [makeThinEndpoint({ completenessScore: 0.8, writeFieldCount: 8, readFieldCount: 10, missingFields: ['phone', 'address'] })],
      thinResponses: [],
      avgCompleteness: 0.8,
    };

    const output = formatAgentReport('my-api', analysis, completeness, 50);

    expect(output).toContain('Agent-Friendliness Report: my-api (50 samples, 1 endpoint');
    expect(output).toContain('VERIFICATION LOOPS');
    // Table contains the pattern and recommendation in cells
    expect(output).toContain('POST /users → GET /users/{userId}');
    expect(output).toContain('120ms');
    expect(output).toContain('Enrich POST response to eliminate GET');
    expect(output).toContain('All write responses return adequate data.');
  });

  it('formats report with thin responses', () => {
    const analysis = makeAnalysis({
      totalRequests: 10,
    });
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
    const analysis = makeAnalysis();
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
    const analysis = makeAnalysis({
      verificationLoops: [makeLoop({ count: 8 })],
      totalRequests: 40,
      wastedRequests: 8,
    });
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
    const analysis = makeAnalysis({
      totalRequests: 5,
    });
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
    const analysis = makeAnalysis({
      sequences: [loopA, loopB],
      verificationLoops: [loopA, loopB],
      totalRequests: 50,
      wastedRequests: 12,
    });
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
    const analysis = makeAnalysis();
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
    const analysis = makeAnalysis({
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 30,
      wastedRequests: 8,
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 30);

    // Table renders pattern in a cell
    expect(output).toContain('create_cluster → get_cluster');
    expect(output).toContain('600ms');
    expect(output).toContain('Enrich write response');
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
    const analysis = makeAnalysis({
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 10,
      wastedRequests: 3,
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);
    expect(output).toContain('Check error handling');
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
    const analysis = makeAnalysis({
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
      totalRequests: 5,
    });
    const completeness: CompletenessReport = {
      endpoints: [thin],
      thinResponses: [thin],
      avgCompleteness: 0.2,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 15);

    // JSON-RPC thin responses: shows just tool name, not full operation key
    expect(output).toContain('create_cluster — 20% complete (2 of 10 fields)');
    expect(output).toContain('Missing: status, region, ports');
    // Should NOT show "tools/call:create_cluster —"
    expect(output).not.toContain('tools/call:create_cluster —');
  });

  it('uses "tools" label instead of "endpoints" for JSON-RPC', () => {
    const analysis = makeAnalysis({
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
      totalRequests: 5,
    });
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
    const analysis = makeAnalysis({
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 10,
      wastedRequests: 4,
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);
    expect(output).toContain('Cache tool list');
  });

  // === New tests for Task #4 features ===

  it('shows TOOL USAGE table with columns', () => {
    const analysis = makeAnalysis({
      toolUsage: [
        { operationKey: 'tools/call:create_cluster', count: 5, isRedundant: false },
        { operationKey: 'tools/list', count: 3, isRedundant: true },
        { operationKey: 'initialize', count: 2, isRedundant: true },
      ],
      redundantCalls: [
        { operationKey: 'tools/list', count: 3, expectedCount: 1 },
        { operationKey: 'initialize', count: 2, expectedCount: 1 },
      ],
      totalRequests: 10,
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);

    expect(output).toContain('TOOL USAGE');
    // Table headers
    expect(output).toContain('Tool');
    expect(output).toContain('Calls');
    expect(output).toContain('Status');
    // Table cell content
    expect(output).toContain('create_cluster');
    expect(output).toContain('tools/list');
    expect(output).toContain('initialize');
    // Redundant status shown in cells
    expect(output).toContain('redundant');
  });

  it('shows REDUNDANT CALLS table with columns', () => {
    const analysis = makeAnalysis({
      toolUsage: [
        { operationKey: 'tools/list', count: 3, isRedundant: true },
      ],
      redundantCalls: [
        { operationKey: 'tools/list', count: 3, expectedCount: 1 },
      ],
      totalRequests: 10,
      wastedRequests: 2,
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);

    expect(output).toContain('REDUNDANT CALLS');
    // Table headers
    expect(output).toContain('Actual');
    expect(output).toContain('Expected');
    expect(output).toContain('Wasted');
    // Table cell content — tools/list: actual=3, expected=1, wasted=2
    expect(output).toContain('tools/list');
  });

  it('does not show REDUNDANT CALLS section when none exist', () => {
    const analysis = makeAnalysis({
      toolUsage: [
        { operationKey: 'tools/call:create_cluster', count: 5, isRedundant: false },
      ],
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 10);
    expect(output).not.toContain('REDUNDANT CALLS');
  });

  it('header uses distinct tool count from toolUsage, not completeness', () => {
    const analysis = makeAnalysis({
      toolUsage: [
        { operationKey: 'tools/call:create_cluster', count: 5, isRedundant: false },
        { operationKey: 'tools/call:get_cluster', count: 3, isRedundant: false },
        { operationKey: 'tools/list', count: 2, isRedundant: true },
        { operationKey: 'initialize', count: 1, isRedundant: false },
      ],
      totalRequests: 11,
    });
    // Completeness report only has 0 endpoints (no matched write/read pairs)
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 11);

    // Should show 4 tools (from toolUsage), not 0 (from completeness)
    expect(output).toContain('4 tools)');
  });

  it('shows MCP thin response message when JSON-RPC with no field data', () => {
    const analysis = makeAnalysis({
      toolUsage: [
        { operationKey: 'tools/call:create_item', count: 2, isRedundant: false },
        { operationKey: 'initialize', count: 1, isRedundant: false },
      ],
      totalRequests: 3,
    });
    // No matched endpoints = no field-level data
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 3);

    expect(output).toContain(
      'MCP responses use text content',
    );
    expect(output).not.toContain('All write responses return adequate data.');
  });

  it('includes redundant call waste in summary', () => {
    const analysis = makeAnalysis({
      toolUsage: [
        { operationKey: 'tools/list', count: 4, isRedundant: true },
        { operationKey: 'initialize', count: 3, isRedundant: true },
      ],
      redundantCalls: [
        { operationKey: 'tools/list', count: 4, expectedCount: 1 },
        { operationKey: 'initialize', count: 3, expectedCount: 1 },
      ],
      totalRequests: 20,
      wastedRequests: 5, // 3 from tools/list + 2 from initialize
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('mcp-api', analysis, completeness, 20);

    expect(output).toContain('Wasted requests: 5 of 20 (25%)');
  });

  it('verification loops table has correct columns', () => {
    const loop = makeLoop({ count: 3, avgDelayMs: 250 });
    const analysis = makeAnalysis({
      sequences: [loop],
      verificationLoops: [loop],
      totalRequests: 10,
      wastedRequests: 3,
    });
    const completeness: CompletenessReport = {
      endpoints: [],
      thinResponses: [],
      avgCompleteness: 0,
    };

    const output = formatAgentReport('test', analysis, completeness, 10);

    // Table headers
    expect(output).toContain('Pattern');
    expect(output).toContain('Occurrences');
    expect(output).toContain('Avg Delay');
    expect(output).toContain('Recommendation');
    // Cell values
    expect(output).toContain('250ms');
  });
});
