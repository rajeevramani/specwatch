import { describe, it, expect } from 'vitest';
import { detectPhases } from '../../src/analysis/phases.js';
import type { Sample } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal JSON-RPC sample for testing. */
function makeJsonRpcSample(
  index: number,
  jsonrpcMethod: string,
  jsonrpcTool: string | undefined,
  capturedAt: string,
): Sample {
  return {
    id: index,
    sessionId: 'test-session',
    httpMethod: 'POST',
    path: '/mcp',
    normalizedPath: '/mcp',
    capturedAt,
    jsonrpcMethod,
    jsonrpcTool,
  };
}

/** Create a minimal REST sample for testing. */
function makeRestSample(
  index: number,
  httpMethod: string,
  normalizedPath: string,
  capturedAt: string,
): Sample {
  return {
    id: index,
    sessionId: 'test-session',
    httpMethod,
    path: normalizedPath,
    normalizedPath,
    capturedAt,
  };
}

/** Produce an ISO timestamp offset by ms from a base time. */
function ts(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase detection', () => {
  const BASE = Date.parse('2026-01-01T00:00:00Z');

  it('splits samples into phases based on timing gaps', () => {
    // Phase 1: two samples 100ms apart
    // Gap of 3000ms
    // Phase 2: two samples 100ms apart
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'initialize', undefined, ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/list', undefined, ts(BASE, 100)),
      // 3s gap
      makeJsonRpcSample(3, 'tools/call', 'cp_create_cluster', ts(BASE, 3200)),
      makeJsonRpcSample(4, 'tools/call', 'cp_list_clusters', ts(BASE, 3300)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].samples).toHaveLength(2);
    expect(result.phases[1].samples).toHaveLength(2);
  });

  it('classifies a phase with only read/list tools as discovery', () => {
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'initialize', undefined, ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/list', undefined, ts(BASE, 100)),
      makeJsonRpcSample(3, 'tools/call', 'cp_list_clusters', ts(BASE, 200)),
      makeJsonRpcSample(4, 'tools/call', 'cp_list_listeners', ts(BASE, 300)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].name).toBe('discovery');
  });

  it('classifies a phase with a write tool as creation', () => {
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'tools/call', 'cp_list_clusters', ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/call', 'cp_create_cluster', ts(BASE, 100)),
      makeJsonRpcSample(3, 'tools/call', 'cp_list_route_configs', ts(BASE, 200)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].name).toBe('creation');
  });

  it('classifies a phase after creation with many list tools as verification', () => {
    const samples: Sample[] = [
      // Phase 1: creation
      makeJsonRpcSample(1, 'tools/call', 'cp_create_cluster', ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/call', 'cp_create_listener', ts(BASE, 100)),
      // 3s gap
      // Phase 2: verification (all reads, high diversity, follows creation)
      makeJsonRpcSample(3, 'tools/call', 'cp_list_clusters', ts(BASE, 3200)),
      makeJsonRpcSample(4, 'tools/call', 'cp_list_listeners', ts(BASE, 3300)),
      makeJsonRpcSample(5, 'tools/call', 'cp_list_route_configs', ts(BASE, 3400)),
      makeJsonRpcSample(6, 'tools/call', 'cp_list_routes', ts(BASE, 3500)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].name).toBe('creation');
    expect(result.phases[1].name).toBe('verification');
  });

  it('produces a single phase when there are no timing gaps', () => {
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'initialize', undefined, ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/list', undefined, ts(BASE, 100)),
      makeJsonRpcSample(3, 'tools/call', 'cp_list_clusters', ts(BASE, 200)),
      makeJsonRpcSample(4, 'tools/call', 'cp_create_cluster', ts(BASE, 300)),
      makeJsonRpcSample(5, 'tools/call', 'cp_list_listeners', ts(BASE, 400)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(1);
  });

  it('correctly tracks multi-phase tools in toolPhaseMap', () => {
    const samples: Sample[] = [
      // Phase 1: discovery
      makeJsonRpcSample(1, 'tools/call', 'cp_list_clusters', ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/call', 'cp_list_listeners', ts(BASE, 100)),
      // 3s gap
      // Phase 2: creation
      makeJsonRpcSample(3, 'tools/call', 'cp_create_cluster', ts(BASE, 3200)),
      makeJsonRpcSample(4, 'tools/call', 'cp_list_clusters', ts(BASE, 3300)),
      // 3s gap
      // Phase 3: verification (follows creation, high diversity)
      makeJsonRpcSample(5, 'tools/call', 'cp_list_clusters', ts(BASE, 6500)),
      makeJsonRpcSample(6, 'tools/call', 'cp_list_listeners', ts(BASE, 6600)),
      makeJsonRpcSample(7, 'tools/call', 'cp_list_routes', ts(BASE, 6700)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(3);

    // cp_list_clusters appears in all three phases
    const clustersPhases = result.toolPhaseMap.get('cp_list_clusters');
    expect(clustersPhases).toEqual(['discovery', 'creation', 'verification']);

    // cp_list_listeners appears in discovery and verification
    const listenersPhases = result.toolPhaseMap.get('cp_list_listeners');
    expect(listenersPhases).toEqual(['discovery', 'verification']);
  });

  it('handles REST sessions using HTTP methods for classification', () => {
    const samples: Sample[] = [
      // Phase 1: discovery (all GETs)
      makeRestSample(1, 'GET', '/users', ts(BASE, 0)),
      makeRestSample(2, 'GET', '/users/{userId}', ts(BASE, 100)),
      // 3s gap
      // Phase 2: creation (has POST)
      makeRestSample(3, 'POST', '/users', ts(BASE, 3200)),
      makeRestSample(4, 'GET', '/users/{userId}', ts(BASE, 3300)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].name).toBe('discovery');
    expect(result.phases[1].name).toBe('creation');
  });

  it('returns empty phases for empty samples', () => {
    const result = detectPhases([]);
    expect(result.phases).toHaveLength(0);
    expect(result.toolPhaseMap.size).toBe(0);
  });

  it('calculates phase duration from first to last sample', () => {
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'tools/call', 'cp_list_clusters', ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/call', 'cp_list_listeners', ts(BASE, 500)),
      makeJsonRpcSample(3, 'tools/call', 'cp_list_routes', ts(BASE, 1200)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].duration).toBe(1200);
  });

  it('classifies operation phase for non-read/non-write tools', () => {
    // A phase with tools that don't match read or write patterns
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'tools/call', 'ops_trace_request', ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/call', 'ops_config_validate', ts(BASE, 100)),
    ];

    const result = detectPhases(samples);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].name).toBe('operation');
  });

  it('sets correct startIndex and endIndex on phases', () => {
    const samples: Sample[] = [
      makeJsonRpcSample(1, 'tools/call', 'cp_list_clusters', ts(BASE, 0)),
      makeJsonRpcSample(2, 'tools/call', 'cp_list_listeners', ts(BASE, 100)),
      // 3s gap
      makeJsonRpcSample(3, 'tools/call', 'cp_create_cluster', ts(BASE, 3200)),
      makeJsonRpcSample(4, 'tools/call', 'cp_create_listener', ts(BASE, 3300)),
    ];

    const result = detectPhases(samples);
    expect(result.phases[0].startIndex).toBe(0);
    expect(result.phases[0].endIndex).toBe(1);
    expect(result.phases[1].startIndex).toBe(2);
    expect(result.phases[1].endIndex).toBe(3);
  });
});
