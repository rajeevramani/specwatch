/**
 * TTY-aware output formatting for Specwatch CLI.
 * Uses chalk for colors, ora for spinners, cli-table3 for tables.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { Session, AggregatedSchema, SchemaDiff } from '../types/index.js';
import type { SequenceAnalysis } from '../analysis/sequences.js';
import type { CompletenessReport } from '../analysis/completeness.js';
import type { PhaseAnalysis } from '../analysis/phases.js';
import type { CallInvestigation, InvestigationReport } from '../analysis/investigation.js';

let verboseMode = false;
let quietMode = false;

export function setVerbose(v: boolean): void {
  verboseMode = v;
}

export function setQuiet(q: boolean): void {
  quietMode = q;
}

export function isInteractive(): boolean {
  return process.stdout.isTTY === true;
}

export function info(msg: string): void {
  if (!quietMode) {
    process.stderr.write(isInteractive() ? chalk.blue(msg) + '\n' : msg + '\n');
  }
}

export function success(msg: string): void {
  if (!quietMode) {
    process.stderr.write(isInteractive() ? chalk.green(msg) + '\n' : msg + '\n');
  }
}

export function warn(msg: string): void {
  process.stderr.write(isInteractive() ? chalk.yellow(msg) + '\n' : msg + '\n');
}

export function error(msg: string, suggestion?: string): void {
  process.stderr.write(isInteractive() ? chalk.red(msg) + '\n' : msg + '\n');
  if (suggestion) {
    process.stderr.write(isInteractive() ? chalk.gray(suggestion) + '\n' : suggestion + '\n');
  }
}

export function verbose(msg: string): void {
  if (verboseMode) {
    process.stderr.write(isInteractive() ? chalk.gray(msg) + '\n' : msg + '\n');
  }
}

export function formatStatus(session: Session): string {
  const lines: string[] = [];
  lines.push(`Session: ${session.id}`);
  lines.push(`Status:  ${session.status}`);
  if (session.name) lines.push(`Name:    ${session.name}`);
  lines.push(`Target:  ${session.targetUrl}`);
  lines.push(`Proxy:   http://localhost:${session.port}`);
  lines.push(`Samples: ${session.sampleCount}${session.skippedCount > 0 ? ` (${session.skippedCount} skipped)` : ''}`);
  if (session.maxSamples) lines.push(`Max:     ${session.maxSamples}`);
  if (session.consumer === 'agent') lines.push(`Consumer: agent`);
  lines.push(`Created: ${session.createdAt}`);
  if (session.errorMessage) lines.push(`Error:   ${session.errorMessage}`);
  return lines.join('\n');
}

export function formatSessionList(sessions: Session[]): string {
  if (sessions.length === 0) {
    return 'No sessions found.';
  }

  if (!isInteractive()) {
    return sessions
      .map(
        (s) =>
          `${s.id}\t${s.name ?? ''}\t${s.status}\t${s.targetUrl}\t${s.sampleCount}\t${s.createdAt}`,
      )
      .join('\n');
  }

  const table = new Table({
    head: ['ID', 'Name', 'Status', 'Target', 'Samples', 'Created'],
    style: { head: ['cyan'] },
  });

  for (const s of sessions) {
    table.push([
      s.id.slice(0, 8),
      s.name ?? '',
      s.status,
      s.targetUrl,
      s.sampleCount.toString(),
      s.createdAt.slice(0, 16).replace('T', ' '),
    ]);
  }

  return table.toString();
}

export interface SnapshotInfo {
  snapshot: number;
  endpointCount: number;
  sampleCount: number;
  avgConfidence: number;
  createdAt: string;
}

export function formatSnapshotList(snapshots: SnapshotInfo[]): string {
  if (snapshots.length === 0) {
    return 'No snapshots found.';
  }

  if (!isInteractive()) {
    return snapshots
      .map((s) => `${s.snapshot}\t${s.endpointCount}\t${s.sampleCount}\t${s.avgConfidence.toFixed(2)}\t${s.createdAt}`)
      .join('\n');
  }

  const table = new Table({
    head: ['Snapshot', 'Endpoints', 'Samples', 'Confidence', 'Created'],
    style: { head: ['cyan'] },
  });

  for (const s of snapshots) {
    table.push([
      s.snapshot.toString(),
      s.endpointCount.toString(),
      s.sampleCount.toString(),
      s.avgConfidence.toFixed(2),
      s.createdAt.slice(0, 16).replace('T', ' '),
    ]);
  }

  return table.toString();
}

export function formatAggregationSummary(
  schemas: AggregatedSchema[],
  sampleCount: number,
): string {
  const avgConfidence =
    schemas.length > 0
      ? schemas.reduce((sum, s) => sum + s.confidenceScore, 0) / schemas.length
      : 0;
  const totalShapes = schemas.reduce((sum, s) => sum + (s.uniqueResponseShapes ?? 0), 0);
  const shapeSuffix = totalShapes > 0 ? `, ${totalShapes} unique response shapes` : '';
  return `${schemas.length} endpoints, ${sampleCount} samples, avg confidence ${avgConfidence.toFixed(2)}${shapeSuffix}`;
}

export function formatDiff(diff: SchemaDiff, endpoint?: string): string {
  const lines: string[] = [];

  if (endpoint) {
    lines.push(`\n${endpoint}:`);
  }

  if (diff.breakingChanges.length > 0) {
    lines.push(`  Breaking Changes (${diff.breakingChanges.length}):`);
    for (const change of diff.breakingChanges) {
      const tag = change.type === 'required_field_removed'
        ? 'REMOVED'
        : change.type === 'incompatible_type_change'
          ? 'TYPE'
          : change.type === 'required_field_added'
            ? 'ADDED'
            : change.type === 'field_became_required'
              ? 'REQUIRED'
              : 'CHANGED';
      lines.push(`    [${tag}] ${change.path} - ${change.description}`);
    }
  }

  if (diff.nonBreakingChanges.length > 0) {
    lines.push(`  Non-Breaking Changes (${diff.nonBreakingChanges.length}):`);
    for (const change of diff.nonBreakingChanges) {
      lines.push(`    [INFO] ${change}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get the recommendation string for a verification loop pattern.
 */
function loopRecommendation(
  loop: { pattern: string; fromMethod: string; toMethod: string },
  isJsonRpc: boolean,
): string {
  if (isJsonRpc) {
    if (loop.pattern === 'retry') return 'Check error handling';
    if (loop.pattern === 'redundant_list') return 'Cache tool list';
    return 'Enrich write response';
  }
  return `Enrich ${loop.fromMethod} response to eliminate ${loop.toMethod}`;
}

/**
 * Format the pattern label for a verification loop.
 */
function loopPatternLabel(
  loop: { fromMethod: string; fromPath: string; toMethod: string; toPath: string },
  isJsonRpc: boolean,
): string {
  if (isJsonRpc) {
    const from = loop.fromPath.replace(/^tools\/call:/, '');
    const to = loop.toPath.replace(/^tools\/call:/, '');
    return `${from} → ${to}`;
  }
  return `${loop.fromMethod} ${loop.fromPath} → ${loop.toMethod} ${loop.toPath}`;
}

export function formatAgentReport(
  sessionName: string,
  sequenceAnalysis: SequenceAnalysis,
  completenessReport: CompletenessReport,
  totalSamples: number,
  phaseAnalysis?: PhaseAnalysis,
  investigationReport?: InvestigationReport,
): string {
  const lines: string[] = [];

  // Detect JSON-RPC mode from analysis data
  const isJsonRpc =
    sequenceAnalysis.sequences.some(
      (s) => s.fromPath.includes('tools/') || s.toPath.includes('tools/'),
    ) ||
    completenessReport.endpoints.some((e) => e.method === 'tools/call') ||
    sequenceAnalysis.toolUsage.some(
      (t) => t.operationKey.startsWith('tools/') || t.operationKey === 'initialize',
    );
  const entityLabel = isJsonRpc ? 'tools' : 'endpoints';

  // Header — count distinct tools/endpoints from toolUsage (sample-derived), not completeness report
  const distinctCount =
    sequenceAnalysis.toolUsage.length > 0
      ? sequenceAnalysis.toolUsage.length
      : completenessReport.endpoints.length;

  lines.push(
    `Agent-Friendliness Report: ${sessionName} (${totalSamples} samples, ${distinctCount} ${entityLabel})`,
  );

  // --- TOOL USAGE table ---
  if (sequenceAnalysis.toolUsage.length > 0) {
    lines.push('');
    lines.push('TOOL USAGE');
    const usageTable = new Table({
      head: ['Tool', 'Calls', 'Status'],
      style: { head: ['cyan'] },
    });
    for (const tool of sequenceAnalysis.toolUsage) {
      const label = isJsonRpc
        ? tool.operationKey.replace(/^tools\/call:/, '')
        : tool.operationKey;
      usageTable.push([
        label,
        tool.count.toString(),
        tool.isRedundant ? 'redundant' : '',
      ]);
    }
    lines.push(usageTable.toString());
  }

  // --- PHASES table ---
  if (phaseAnalysis && phaseAnalysis.phases.length > 0) {
    lines.push('');
    lines.push('PHASES');
    const phaseTable = new Table({
      head: ['Phase', 'Tools', 'Duration', 'Samples'],
      style: { head: ['cyan'] },
      colWidths: [null, 50, null, null],
      wordWrap: true,
    });
    for (const phase of phaseAnalysis.phases) {
      const uniqueTools = [...new Set(phase.samples.map((s) => {
        const label = s.toolName ?? s.operationKey;
        return isJsonRpc ? label.replace(/^tools\/call:/, '') : label;
      }))];
      const toolsStr = uniqueTools.join(', ');
      const durationStr = phase.duration < 1000
        ? `${phase.duration}ms`
        : `${(phase.duration / 1000).toFixed(1)}s`;
      phaseTable.push([
        phase.name,
        toolsStr,
        durationStr,
        phase.samples.length.toString(),
      ]);
    }
    lines.push(phaseTable.toString());

    // Show multi-phase tools
    const multiPhaseTools: [string, string[]][] = [];
    for (const [tool, phases] of phaseAnalysis.toolPhaseMap) {
      if (phases.length > 1) {
        const label = isJsonRpc ? tool.replace(/^tools\/call:/, '') : tool;
        multiPhaseTools.push([label, phases]);
      }
    }
    if (multiPhaseTools.length > 0) {
      lines.push('');
      lines.push('MULTI-PHASE TOOLS');
      const multiTable = new Table({
        head: ['Tool', 'Phases'],
        style: { head: ['cyan'] },
      });
      for (const [tool, phases] of multiPhaseTools) {
        multiTable.push([tool, phases.join(' → ')]);
      }
      lines.push(multiTable.toString());
    }
  }

  // --- VERIFICATION LOOPS table ---
  lines.push('');
  lines.push('VERIFICATION LOOPS');
  const loops = [...sequenceAnalysis.verificationLoops].sort((a, b) => b.count - a.count);
  if (loops.length === 0) {
    lines.push('  No verification loops detected.');
  } else {
    const loopTable = new Table({
      head: ['Pattern', 'Occurrences', 'Avg Delay', 'Recommendation'],
      style: { head: ['cyan'] },
    });
    for (const loop of loops) {
      loopTable.push([
        loopPatternLabel(loop, isJsonRpc),
        loop.count.toString(),
        `${loop.avgDelayMs}ms`,
        loopRecommendation(loop, isJsonRpc),
      ]);
    }
    lines.push(loopTable.toString());
  }

  // --- REDUNDANT CALLS table (JSON-RPC only) ---
  if (sequenceAnalysis.redundantCalls.length > 0) {
    lines.push('');
    lines.push('REDUNDANT CALLS');
    const hasInvestigation = investigationReport && investigationReport.investigations.length > 0;
    const redundantHead = hasInvestigation
      ? ['Tool', 'Actual', 'Expected', 'Wasted', 'Why']
      : ['Tool', 'Actual', 'Expected', 'Wasted'];
    const redundantTable = new Table({
      head: redundantHead,
      style: { head: ['cyan'] },
      ...(hasInvestigation
        ? { wordWrap: true, colWidths: [undefined, 8, 10, 8, 46] }
        : {}),
    });
    for (const r of sequenceAnalysis.redundantCalls) {
      const extra = r.count - r.expectedCount;
      const label = isJsonRpc
        ? r.operationKey.replace(/^tools\/call:/, '')
        : r.operationKey;
      const row: string[] = [
        label,
        r.count.toString(),
        r.expectedCount.toString(),
        extra.toString(),
      ];
      if (hasInvestigation) {
        const inv = investigationReport!.investigations.find(
          (i) => i.operationKey === r.operationKey,
        );
        row.push(inv ? inv.explanation : '');
      }
      redundantTable.push(row);
    }
    lines.push(redundantTable.toString());
  }

  // --- THIN RESPONSES ---
  lines.push('');
  lines.push('THIN RESPONSES');
  const thin = [...completenessReport.thinResponses].sort(
    (a, b) => a.completenessScore - b.completenessScore,
  );
  if (thin.length === 0) {
    // For JSON-RPC sessions with no matched write/read pairs, show MCP-specific message
    const hasFieldData = completenessReport.endpoints.length > 0;
    if (isJsonRpc && !hasFieldData) {
      const noteTable = new Table({
        head: ['Note'],
        style: { head: ['cyan'] },
      });
      noteTable.push(['MCP responses use text content — field-level scoring not available']);
      lines.push(noteTable.toString());
    } else {
      lines.push('  All write responses return adequate data.');
    }
  } else {
    for (const endpoint of thin) {
      const pct = Math.round(endpoint.completenessScore * 100);
      // JSON-RPC: path is "tools/call:tool_name", display just the tool name
      const label = isJsonRpc
        ? endpoint.path.replace(/^tools\/call:/, '')
        : `${endpoint.method} ${endpoint.path}`;
      lines.push(
        `  ${label} — ${pct}% complete (${endpoint.writeFieldCount} of ${endpoint.readFieldCount} fields)`,
      );
      if (endpoint.missingFields.length > 0) {
        const MAX_FIELDS = 5;
        const shown = endpoint.missingFields.slice(0, MAX_FIELDS);
        const remaining = endpoint.missingFields.length - MAX_FIELDS;
        const fieldList =
          remaining > 0 ? `${shown.join(', ')}, ... and ${remaining} more` : shown.join(', ');
        lines.push(`    Missing: ${fieldList}`);
      }
    }
  }

  // --- SUMMARY ---
  lines.push('');
  lines.push('SUMMARY');
  const { totalRequests, wastedRequests } = sequenceAnalysis;
  const wastedPct = totalRequests > 0 ? Math.round((wastedRequests / totalRequests) * 100) : 0;
  lines.push(`  Wasted requests: ${wastedRequests} of ${totalRequests} (${wastedPct}%)`);
  lines.push(`  Avg response completeness: ${completenessReport.avgCompleteness.toFixed(2)}`);

  return lines.join('\n');
}

/**
 * Format a detailed investigation of a single redundant operation.
 * Used by the `investigate` command for deep-dive analysis.
 */
export function formatInvestigation(investigation: CallInvestigation): string {
  const lines: string[] = [];

  lines.push(
    `Investigation: ${investigation.operationKey} (${investigation.occurrences.length} calls, expected 1)`,
  );

  // --- TIMELINE table ---
  lines.push('');
  lines.push('TIMELINE');
  const timelineTable = new Table({
    head: ['#', 'Time', 'Status', 'Phase', 'Delta'],
    style: { head: ['cyan'] },
  });
  for (let i = 0; i < investigation.occurrences.length; i++) {
    const occ = investigation.occurrences[i];
    const time = occ.capturedAt.slice(0, 19).replace('T', ' ');
    const status = occ.statusCode !== undefined ? occ.statusCode.toString() : '';
    const phase = occ.phase ?? '';
    let delta = '\u2014'; // em dash
    if (i > 0) {
      const prev = investigation.occurrences[i - 1];
      const deltaMs =
        new Date(occ.capturedAt).getTime() - new Date(prev.capturedAt).getTime();
      delta = `+${(deltaMs / 1000).toFixed(1)}s`;
    }
    timelineTable.push([(i + 1).toString(), time, status, phase, delta]);
  }
  lines.push(timelineTable.toString());

  // --- PAIR ANALYSIS ---
  if (investigation.pairAnalyses.length > 0) {
    lines.push('');
    lines.push('PAIR ANALYSIS');
    for (const pair of investigation.pairAnalyses) {
      const fromIdx =
        investigation.occurrences.findIndex((o) => o.sampleIndex === pair.fromIndex) + 1;
      const toIdx =
        investigation.occurrences.findIndex((o) => o.sampleIndex === pair.toIndex) + 1;
      const deltaStr = `+${(pair.deltaMs / 1000).toFixed(1)}s`;

      let phaseStr: string;
      if (pair.crossPhase) {
        const fromPhase = investigation.occurrences[fromIdx - 1]?.phase ?? '?';
        const toPhase = investigation.occurrences[toIdx - 1]?.phase ?? '?';
        phaseStr = `cross-phase (${fromPhase} \u2192 ${toPhase})`;
      } else {
        const phase = investigation.occurrences[fromIdx - 1]?.phase;
        phaseStr = phase ? `same phase (${phase})` : 'same phase';
      }

      lines.push(`  Call ${fromIdx} \u2192 ${toIdx}:  ${deltaStr}, ${phaseStr}`);

      // Request diff
      if (pair.requestDiff) {
        const changes =
          pair.requestDiff.breakingChanges.length + pair.requestDiff.nonBreakingChanges.length;
        lines.push(changes === 0 ? '    Request:  identical' : `    Request:  ${changes} fields changed`);
      } else {
        lines.push('    Request:  identical');
      }

      // Response diff
      if (pair.responseDiff) {
        const bc = pair.responseDiff.breakingChanges.length;
        const nbc = pair.responseDiff.nonBreakingChanges.length;
        if (bc === 0 && nbc === 0) {
          lines.push('    Response: identical');
        } else {
          const parts: string[] = [];
          if (bc > 0) parts.push(`${bc} breaking`);
          if (nbc > 0) parts.push(`${nbc} non-breaking`);
          lines.push(`    Response: ${parts.join(', ')} changes`);
        }
      } else {
        lines.push('    Response: identical');
      }

      // Intervening ops
      const between =
        pair.interveningOps.length > 0 ? pair.interveningOps.join(', ') : '(none)';
      lines.push(`    Between:  ${between}`);

      // Cause
      const causeFormatted = pair.cause.replace(/_/g, ' ');
      lines.push(`    Cause:    ${causeFormatted}`);
    }
  }

  // --- RECOMMENDATION ---
  lines.push('');
  lines.push(`RECOMMENDATION: ${investigation.recommendation}`);

  return lines.join('\n');
}
