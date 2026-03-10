/**
 * TTY-aware output formatting for Specwatch CLI.
 * Uses chalk for colors, ora for spinners, cli-table3 for tables.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { Session, AggregatedSchema, SchemaDiff } from '../types/index.js';

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
