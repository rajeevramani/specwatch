/**
 * Commander command definitions for Specwatch CLI.
 *
 * Commands:
 *   start <url>           Start a proxy session
 *   status                Show current session status
 *   stop                  Stop the active session and aggregate
 *   aggregate [session]   Run aggregation on a session
 *   export [session]      Export OpenAPI spec or raw JSON
 *   sessions list         List all sessions
 *   sessions delete <id>  Delete a session
 *   diff <session1> <session2>  Compare schemas between sessions
 *   investigate [session]       Deep-dive investigation of redundant calls
 */

import { Command } from 'commander';
import { getDatabase } from '../storage/database.js';
import { SessionRepository } from '../storage/sessions.js';
import { SampleRepository } from '../storage/samples.js';
import { AggregatedSchemaRepository } from '../storage/schemas.js';
import { ProxyServer, registerShutdownHandlers } from '../proxy/server.js';
import { captureRequestResponse } from '../proxy/middleware.js';
import { inferSchema } from '../inference/engine.js';
import { normalizePath } from '../inference/path-normalizer.js';
import { runAggregation } from '../aggregation/pipeline.js';
import { detectBreakingChanges } from '../aggregation/diff.js';
import { buildOpenApiDocument, serializeOpenApi, convertToOpenApi30 } from '../export/openapi.js';
import { buildJsonExport, serializeJson } from '../export/json.js';
import { detectSequences } from '../analysis/sequences.js';
import { detectPhases } from '../analysis/phases.js';
import { investigateRedundantCalls, investigateOperation } from '../analysis/investigation.js';
import { analyzeCompleteness, analyzeJsonRpcCompleteness } from '../analysis/completeness.js';
import { buildAgentExtensions } from '../analysis/agent-extensions.js';
import { extractJsonRpcFromBody, isJsonRpcSession, unwrapMcpResponse } from '../analysis/jsonrpc.js';
import type { AgentExtension } from '../analysis/agent-extensions.js';
import { discoverDomainModels } from '../export/domain-models.js';
import {
  info,
  success,
  warn,
  error as logError,
  verbose,
  setVerbose,
  setQuiet,
  formatStatus,
  formatSessionList,
  formatAggregationSummary,
  formatDiff,
  formatSnapshotList,
  formatAgentReport,
  formatInvestigation,
} from './output.js';
import { SpecwatchError, noActiveSessionError, sessionNotFoundError, sessionNameNotFoundError, noCompletedSessionsError } from './errors.js';
import { loadLlmConfig } from '../llm/config.js';
import { explainAllInvestigations } from '../llm/client.js';
import type { ExportOptions, AggregatedSchema, SessionConsumer } from '../types/index.js';

/**
 * Resolve a session by ID, name, or fallback strategy.
 * @param sessions - Session repository
 * @param id - Session ID (takes priority)
 * @param name - Session name (second priority)
 * @param fallback - Fallback when neither ID nor name provided: 'active' or 'latest'
 * @returns Resolved session ID
 */
function resolveSessionId(
  sessions: SessionRepository,
  id: string | undefined,
  name: string | undefined,
  fallback: 'active' | 'latest' | 'none',
): string {
  if (id) {
    const session = sessions.getSession(id);
    if (!session) throw sessionNotFoundError(id);
    return id;
  }
  if (name) {
    const session = sessions.getSessionByName(name);
    if (!session) throw sessionNameNotFoundError(name);
    return session.id;
  }
  if (fallback === 'active') {
    const active = sessions.getActiveSession();
    if (!active) throw noActiveSessionError();
    return active.id;
  }
  if (fallback === 'latest') {
    const latest = sessions.getLatestCompleted();
    if (!latest) throw noCompletedSessionsError();
    return latest.id;
  }
  throw new SpecwatchError('Session is required.', 'Provide a session ID or use --name.');
}

function handleError(err: unknown): never {
  if (err instanceof SpecwatchError) {
    logError(err.message, err.suggestion);
  } else if (err instanceof Error) {
    logError(err.message);
  } else {
    logError(String(err));
  }
  process.exit(1);
}

/**
 * Parse a URL query string into a Record<string, string>.
 */
function parseQueryParams(url: string): Record<string, string> | undefined {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return undefined;
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(url.slice(queryStart + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('specwatch')
    .description('Learn API schemas from live traffic and generate OpenAPI specs')
    .version('0.3.1')
    .option('-v, --verbose', 'Enable verbose output')
    .option('-q, --quiet', 'Suppress non-essential output')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts['verbose']) setVerbose(true);
      if (opts['quiet']) setQuiet(true);
    });

  // ========== start ==========
  program
    .command('start')
    .description('Start a proxy session to learn API schemas from live traffic')
    .argument('<url>', 'Target API URL to proxy (e.g., https://api.example.com)')
    .option('-p, --port <port>', 'Local proxy port', '8080')
    .option('-n, --name <name>', 'Session name')
    .option('--max-samples <count>', 'Maximum samples to capture')
    .option('--auto-aggregate', 'Auto-aggregate every --max-samples and continue capturing')
    .option('--consumer <type>', 'Consumer type: human or agent', 'human')
    .action(async (url: string, opts: Record<string, string>) => {
      try {
        const port = parseInt(opts['port'], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          throw new SpecwatchError('Invalid port number.', 'Use a port between 1 and 65535.');
        }

        const maxSamples = opts['maxSamples'] ? parseInt(opts['maxSamples'], 10) : undefined;
        const consumer = opts['consumer'] as string;
        if (consumer !== 'human' && consumer !== 'agent') {
          throw new SpecwatchError(
            `Invalid consumer type: '${consumer}'.`,
            "Use --consumer human or --consumer agent.",
          );
        }
        const autoAggregate = opts['autoAggregate'] === true || opts['autoAggregate'] === '';
        if (autoAggregate && maxSamples === undefined) {
          throw new SpecwatchError(
            '--auto-aggregate requires --max-samples.',
            'Example: specwatch start <url> --max-samples 200 --auto-aggregate',
          );
        }

        // Validate URL
        let targetUrl: string;
        try {
          const parsed = new URL(url);
          targetUrl = parsed.origin + parsed.pathname.replace(/\/$/, '');
        } catch {
          throw new SpecwatchError(
            `Invalid URL: ${url}`,
            'Provide a valid URL like https://api.example.com',
          );
        }

        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const sampleRepo = new SampleRepository(db);

        // Check for existing active session
        const existing = sessions.getActiveSession();
        if (existing) {
          throw new SpecwatchError(
            `Session '${existing.id.slice(0, 8)}' is already active on port ${existing.port}.`,
            "Stop it first with 'specwatch stop'.",
          );
        }

        const session = sessions.createSession(targetUrl, port, opts['name'], maxSamples, consumer as SessionConsumer);

        const _proxy = new ProxyServer({
          targetUrl,
          port,
          onCapture: (_req, _res) => {
            try {
              // This runs post-response (non-blocking)
              // We need to use the async capture, but onCapture is sync.
              // Instead, we wire capture in the request handler.
            } catch {
              // swallow
            }
          },
        });

        // Wire the capture pipeline into the proxy
        // We need a custom approach: intercept before proxy forwards
        // Override the proxy's request handling by using a wrapper
        let sampleCount = 0;
        let _skippedCount = 0;
        let currentSnapshot = 0;
        let samplesSinceLastSnapshot = 0;

        // Create a new proxy with proper async capture
        const _captureProxy = new ProxyServer({
          targetUrl,
          port,
        });

        // We can't easily inject async capture into ProxyServer's sync onCapture.
        // Instead, we'll create a raw HTTP server that calls captureRequestResponse
        // before proxying, then forwards to the target.
        // But ProxyServer already creates the server... We need to use a different approach.

        // Actually, looking at the ProxyServer design: onCapture fires on res 'finish'.
        // But captureRequestResponse needs to be called BEFORE the proxy forwards.
        // The right approach is to create a custom HTTP server.

        const httpProxy = await import('http-proxy');
        const http = await import('node:http');

        const proxyInstance = httpProxy.default.createProxyServer({
          target: targetUrl,
          changeOrigin: true,
          secure: true,
          timeout: 30_000,
          proxyTimeout: 30_000,
        });

        proxyInstance.on('error', (err, _req, res) => {
          if (res instanceof http.ServerResponse && !res.headersSent) {
            const isTimeout =
              (err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
              err.message.toLowerCase().includes('timeout') ||
              err.message.toLowerCase().includes('socket hang up');
            const statusCode = isTimeout ? 504 : 502;
            const message = isTimeout ? 'Gateway Timeout' : 'Bad Gateway';
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: message, message: err.message }));
          }
        });

        const server = http.createServer(async (req, res) => {
          // Set up capture BEFORE proxying
          const capturePromise = captureRequestResponse(req, res);

          // Forward to upstream
          proxyInstance.web(req, res);

          // After response finishes, process the capture
          try {
            const pair = await capturePromise;

            // Check max samples (skip when auto-aggregating — limit is per-snapshot, not cumulative)
            if (maxSamples !== undefined && !autoAggregate && sampleCount >= maxSamples) {
              return;
            }

            // Check if body was skipped
            if (pair.requestBodySkipped || pair.responseBodySkipped) {
              sessions.incrementSkippedCount(session.id);
              _skippedCount++;
              verbose(`Skipped oversized body: ${pair.method} ${pair.url}`);
              return;
            }

            // Extract JSON-RPC method and tool name if present
            const jsonrpc = extractJsonRpcFromBody(pair.requestBody);

            // Infer schemas
            const requestSchema = pair.requestBody !== undefined
              ? inferSchema(pair.requestBody)
              : undefined;
            // Unwrap MCP tool responses to infer schema from actual content
            const responseBody = jsonrpc?.method?.startsWith('tools/')
              ? unwrapMcpResponse(pair.responseBody)
              : pair.responseBody;
            const responseSchema = responseBody !== undefined
              ? inferSchema(responseBody)
              : undefined;

            // Normalize path
            const normalizedPath = normalizePath(pair.url);

            // Parse query params
            const queryParams = parseQueryParams(pair.url);

            // Insert sample
            sampleRepo.insertSample({
              sessionId: session.id,
              httpMethod: pair.method,
              path: pair.url.split('?')[0],
              normalizedPath,
              statusCode: pair.statusCode,
              queryParams,
              requestSchema,
              responseSchema,
              requestHeaders: pair.requestHeaders,
              responseHeaders: pair.responseHeaders,
              capturedAt: pair.capturedAt,
              jsonrpcMethod: jsonrpc?.method,
              jsonrpcTool: jsonrpc?.tool,
            });

            sessions.incrementSampleCount(session.id);
            sampleCount++;
            samplesSinceLastSnapshot++;

            verbose(
              `[${sampleCount}] ${pair.method} ${pair.url} → ${pair.statusCode}`,
            );

            // Check max samples threshold
            if (maxSamples !== undefined && samplesSinceLastSnapshot >= maxSamples) {
              if (autoAggregate) {
                // Auto-aggregate: create a new cumulative snapshot and keep going
                currentSnapshot++;
                info(`\nAuto-aggregating snapshot ${currentSnapshot} (${sampleCount} total samples)...`);
                try {
                  const result = runAggregation(db, session.id, {
                    snapshot: currentSnapshot,
                    skipStateTransition: true,
                  });
                  success(`Snapshot ${currentSnapshot}: ${result.schemas.length} endpoints from ${result.sampleCount} samples`);
                } catch (aggErr) {
                  logError(
                    `Auto-aggregation failed: ${aggErr instanceof Error ? aggErr.message : String(aggErr)}`,
                  );
                }
                samplesSinceLastSnapshot = 0;
              } else {
                // No auto-aggregate: stop capturing
                info(`\nReached max samples (${maxSamples}). Stopping...`);
                server.close();
              }
            }
          } catch (captureErr) {
            verbose(
              `Capture error: ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
            );
          }
        });

        // Check if port is already in use (covers IPv4/IPv6/wildcard bindings)
        const net = await import('node:net');
        await new Promise<void>((resolve, reject) => {
          const testSocket = net.createConnection({ port, host: '127.0.0.1' });
          testSocket.once('connect', () => {
            testSocket.destroy();
            reject(
              new SpecwatchError(
                `Port ${port} is already in use.`,
                `Try: specwatch start ${targetUrl} --port ${port + 1}`,
              ),
            );
          });
          testSocket.once('error', () => {
            testSocket.destroy();
            resolve();
          });
        });

        // Start listening
        await new Promise<void>((resolve, reject) => {
          server.listen(port, '127.0.0.1', () => resolve());
          server.once('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
              reject(new SpecwatchError(
                `Port ${port} is already in use.`,
                `Try: specwatch start ${targetUrl} --port ${port + 1}`,
              ));
            } else {
              reject(err);
            }
          });
        });

        info(`Specwatch proxy started`);
        info(`  Session: ${session.id.slice(0, 8)}`);
        if (session.name) info(`  Name:    ${session.name}`);
        info(`  Target:  ${targetUrl}`);
        info(`  Proxy:   http://localhost:${port}`);
        if (maxSamples) info(`  Max:     ${maxSamples} samples`);
        if (autoAggregate) info(`  Mode:    auto-aggregate every ${maxSamples} samples`);
        info(`\nPress Ctrl+C to stop and aggregate.`);

        // Register shutdown handlers
        const _cleanup = registerShutdownHandlers(async (forceQuit) => {
          if (forceQuit) {
            warn('\nForce quit — skipping aggregation.');
            server.close();
            proxyInstance.close();
            return;
          }

          info('\nStopping proxy...');
          server.close();
          proxyInstance.close();

          const updatedSession = sessions.getSession(session.id);
          const count = updatedSession?.sampleCount ?? sampleCount;

          if (count === 0) {
            info('No samples captured. Nothing to aggregate.');
            sessions.updateSessionStatus(session.id, 'aggregating');
            sessions.updateSessionStatus(session.id, 'completed');
            return;
          }

          info(`Aggregating ${count} samples...`);
          try {
            if (autoAggregate) {
              // Final snapshot with any remaining samples
              currentSnapshot++;
              const result = runAggregation(db, session.id, {
                snapshot: currentSnapshot,
                skipStateTransition: true,
              });
              // Now transition to completed
              sessions.updateSessionStatus(session.id, 'aggregating');
              sessions.updateSessionStatus(session.id, 'completed');
              success(`Final snapshot ${currentSnapshot}: ${result.schemas.length} endpoints from ${result.sampleCount} samples`);
              info(`\nExport with: specwatch export --name "${session.name ?? session.id.slice(0, 8)}"`);
              info(`Diff snapshots: specwatch diff --name "${session.name ?? session.id.slice(0, 8)}" --snapshots 1 ${currentSnapshot}`);
            } else {
              const result = runAggregation(db, session.id);
              success(`Done! ${formatAggregationSummary(result.schemas, result.sampleCount)}`);
              info(`\nExport with: specwatch export`);
            }
          } catch (aggErr) {
            logError(
              `Aggregation failed: ${aggErr instanceof Error ? aggErr.message : String(aggErr)}`,
            );
          }
        });

        // Keep the process alive
        await new Promise<void>(() => {
          // This promise never resolves — the process exits via shutdown handlers
        });
      } catch (err) {
        handleError(err);
      }
    });

  // ========== status ==========
  program
    .command('status')
    .description('Show the current active session status')
    .action(() => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const active = sessions.getActiveSession();
        if (!active) {
          throw noActiveSessionError();
        }
        process.stdout.write(formatStatus(active) + '\n');
      } catch (err) {
        handleError(err);
      }
    });

  // ========== stop ==========
  program
    .command('stop')
    .description('Stop the active session and run aggregation')
    .action(() => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const active = sessions.getActiveSession();
        if (!active) {
          throw noActiveSessionError();
        }

        info(`Stopping session ${active.id.slice(0, 8)}...`);

        if (active.sampleCount === 0) {
          info('No samples captured. Nothing to aggregate.');
          sessions.updateSessionStatus(active.id, 'aggregating');
          sessions.updateSessionStatus(active.id, 'completed');
          return;
        }

        info(`Aggregating ${active.sampleCount} samples...`);
        const result = runAggregation(db, active.id);
        success(`Done! ${formatAggregationSummary(result.schemas, result.sampleCount)}`);
        info(`\nExport with: specwatch export`);
      } catch (err) {
        handleError(err);
      }
    });

  // ========== aggregate ==========
  program
    .command('aggregate')
    .description('Run aggregation on a session')
    .argument('[session]', 'Session ID (defaults to active session)')
    .option('--name <name>', 'Session name (alternative to session ID)')
    .action((sessionId: string | undefined, opts: Record<string, string | undefined>) => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const targetId = resolveSessionId(sessions, sessionId, opts['name'], 'active');

        info(`Aggregating session ${targetId.slice(0, 8)}...`);
        const result = runAggregation(db, targetId);
        success(`Done! ${formatAggregationSummary(result.schemas, result.sampleCount)}`);
      } catch (err) {
        handleError(err);
      }
    });

  // ========== export ==========
  program
    .command('export')
    .description('Export OpenAPI spec or raw JSON')
    .argument('[session]', 'Session ID (defaults to latest completed)')
    .option('-f, --format <format>', 'Output format: openapi, json', 'openapi')
    .option('-o, --output <file>', 'Output file (defaults to stdout)')
    .option('--yaml', 'Output YAML (default for openapi)')
    .option('--json', 'Output JSON')
    .option('--title <title>', 'OpenAPI title')
    .option('--version <version>', 'OpenAPI version string')
    .option('--min-confidence <n>', 'Minimum confidence threshold (0-1)', '0')
    .option('--openapi-version <ver>', 'OpenAPI version: 3.0 or 3.1', '3.1')
    .option('--include-metadata', 'Include x-specwatch-* extensions')
    .option('--name <name>', 'Session name (alternative to session ID)')
    .option('--snapshot <n>', 'Snapshot number (defaults to latest)')
    .action(async (sessionId: string | undefined, opts: Record<string, string | boolean | undefined>) => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const schemaRepo = new AggregatedSchemaRepository(db);

        // Resolve session
        const targetId = resolveSessionId(sessions, sessionId, opts['name'] as string | undefined, 'latest');

        const snapshotOpt = opts['snapshot'] as string | undefined;
        const schemas = snapshotOpt !== undefined
          ? schemaRepo.listBySessionSnapshot(targetId, parseInt(snapshotOpt, 10))
          : schemaRepo.listBySessionLatestSnapshot(targetId);
        if (schemas.length === 0) {
          throw new SpecwatchError(
            snapshotOpt !== undefined
              ? `No schemas found for snapshot ${snapshotOpt}.`
              : 'No schemas found for this session.',
            'Run aggregation first: specwatch aggregate',
          );
        }

        // Apply confidence filter
        const minConfidence = parseFloat(opts['minConfidence'] as string ?? '0');
        const filtered = schemas.filter((s) => s.confidenceScore >= minConfidence);

        if (filtered.length === 0) {
          throw new SpecwatchError(
            `No schemas meet the minimum confidence threshold of ${minConfidence}.`,
            'Try lowering --min-confidence or capturing more traffic.',
          );
        }

        const format = opts['format'] as string;
        let output: string;

        if (format === 'json') {
          const exported = buildJsonExport(filtered);
          output = serializeJson(exported);
        } else {
          // OpenAPI
          const exportOptions: Partial<ExportOptions> = {
            title: opts['title'] as string | undefined,
            version: opts['version'] as string | undefined,
            includeMetadata: opts['includeMetadata'] === true,
          };

          // Build agent extensions for agent sessions
          let agentExtensionsMap: Record<string, AgentExtension> | undefined;
          const session = sessions.getSession(targetId);
          if (session?.consumer === 'agent') {
            const sequenceAnalysis = detectSequences(db, targetId);
            const sampleRepo = new SampleRepository(db);
            const samples = sampleRepo.listBySession(targetId);
            const jsonRpc = isJsonRpcSession(samples);
            const completenessReport = jsonRpc
              ? analyzeJsonRpcCompleteness(samples)
              : analyzeCompleteness(filtered);
            agentExtensionsMap = buildAgentExtensions(
              sequenceAnalysis,
              completenessReport,
              jsonRpc,
            );
            if (Object.keys(agentExtensionsMap).length === 0) {
              agentExtensionsMap = undefined;
            }
          }

          const domainModels = discoverDomainModels(filtered);
          let doc = buildOpenApiDocument(filtered, exportOptions, agentExtensionsMap, domainModels);
          const openapiVersion = opts['openapiVersion'] as string | undefined;
          if (openapiVersion === '3.0') {
            doc = convertToOpenApi30(doc);
          }
          const serializationFormat = opts['json'] ? 'json' as const : 'yaml' as const;
          output = serializeOpenApi(doc, serializationFormat);
        }

        // Output
        const outputFile = opts['output'] as string | undefined;
        if (outputFile) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(outputFile, output + '\n', 'utf8');
          success(`Exported ${filtered.length} endpoints to ${outputFile}`);
        } else {
          process.stdout.write(output + '\n');
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ========== sessions ==========
  const sessionsCmd = program
    .command('sessions')
    .description('Manage sessions');

  sessionsCmd
    .command('list')
    .description('List all sessions')
    .action(() => {
      try {
        const db = getDatabase();
        const sessionRepo = new SessionRepository(db);
        const all = sessionRepo.listSessions();
        process.stdout.write(formatSessionList(all) + '\n');
      } catch (err) {
        handleError(err);
      }
    });

  sessionsCmd
    .command('delete')
    .description('Delete a session and its data')
    .argument('<id>', 'Session ID to delete')
    .action((id: string) => {
      try {
        const db = getDatabase();
        const sessionRepo = new SessionRepository(db);
        const session = sessionRepo.getSession(id);
        if (!session) throw sessionNotFoundError(id);

        sessionRepo.deleteSession(id);
        success(`Deleted session ${id.slice(0, 8)}`);
      } catch (err) {
        handleError(err);
      }
    });

  // ========== snapshots ==========
  program
    .command('snapshots')
    .description('List snapshots for a session')
    .argument('[session]', 'Session ID (defaults to latest completed)')
    .option('--name <name>', 'Session name (alternative to session ID)')
    .action((sessionId: string | undefined, opts: Record<string, string | undefined>) => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const schemaRepo = new AggregatedSchemaRepository(db);

        const targetId = resolveSessionId(sessions, sessionId, opts['name'], 'latest');
        const snapshots = schemaRepo.listSnapshotsForSession(targetId);
        process.stdout.write(formatSnapshotList(snapshots) + '\n');
      } catch (err) {
        handleError(err);
      }
    });

  // ========== diff ==========
  program
    .command('diff')
    .description('Compare schemas between two sessions')
    .argument('[session1]', 'First session ID (older)')
    .argument('[session2]', 'Second session ID (newer)')
    .option('--name1 <name>', 'First session name (alternative to session1 ID)')
    .option('--name2 <name>', 'Second session name (alternative to session2 ID)')
    .option('--name <name>', 'Session name (for comparing snapshots within a session)')
    .option('--snapshots <numbers...>', 'Compare two snapshots within the same session')
    .action((session1: string | undefined, session2: string | undefined, opts: Record<string, string | undefined>) => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const schemaRepo = new AggregatedSchemaRepository(db);

        let schemas1: AggregatedSchema[];
        let schemas2: AggregatedSchema[];

        const snapshotsOpt = opts['snapshots'] as string[] | undefined;
        if (snapshotsOpt !== undefined) {
          // Snapshot comparison within a single session
          const sessionName = opts['name'] as string | undefined;
          const targetId = resolveSessionId(sessions, session1, sessionName, 'latest');

          // Parse snapshot numbers from variadic option: --snapshots 1 2
          if (snapshotsOpt.length !== 2) {
            throw new SpecwatchError(
              'Exactly two snapshot numbers are required.',
              'Example: specwatch diff --name bank-demo --snapshots 1 2',
            );
          }
          const snap1 = parseInt(snapshotsOpt[0], 10);
          const snap2 = parseInt(snapshotsOpt[1], 10);
          if (isNaN(snap1) || isNaN(snap2)) {
            throw new SpecwatchError(
              'Two snapshot numbers are required.',
              'Example: specwatch diff --name bank-demo --snapshots 1 2',
            );
          }

          schemas1 = schemaRepo.listBySessionSnapshot(targetId, snap1);
          schemas2 = schemaRepo.listBySessionSnapshot(targetId, snap2);

          if (schemas1.length === 0) {
            throw new SpecwatchError(
              `No schemas found for snapshot ${snap1}.`,
              `Available snapshots: 1 to ${schemaRepo.getMaxSnapshotForSession(targetId)}`,
            );
          }
          if (schemas2.length === 0) {
            throw new SpecwatchError(
              `No schemas found for snapshot ${snap2}.`,
              `Available snapshots: 1 to ${schemaRepo.getMaxSnapshotForSession(targetId)}`,
            );
          }
        } else {
          // Cross-session comparison (original behavior)
          const id1 = resolveSessionId(sessions, session1, opts['name1'], 'none');
          const id2 = resolveSessionId(sessions, session2, opts['name2'], 'none');

          schemas1 = schemaRepo.listBySessionLatestSnapshot(id1);
          schemas2 = schemaRepo.listBySessionLatestSnapshot(id2);

          if (schemas1.length === 0) {
            throw new SpecwatchError(
              `No schemas found for session '${id1.slice(0, 8)}'.`,
              'Run aggregation first: specwatch aggregate ' + id1,
            );
          }
          if (schemas2.length === 0) {
            throw new SpecwatchError(
              `No schemas found for session '${id2.slice(0, 8)}'.`,
              'Run aggregation first: specwatch aggregate ' + id2,
            );
          }
        }

        // Build map from endpoint key to schema
        const map1 = new Map<string, AggregatedSchema>();
        for (const s of schemas1) {
          map1.set(`${s.httpMethod} ${s.path}`, s);
        }
        const map2 = new Map<string, AggregatedSchema>();
        for (const s of schemas2) {
          map2.set(`${s.httpMethod} ${s.path}`, s);
        }

        // Find all unique endpoints
        const allEndpoints = new Set([...map1.keys(), ...map2.keys()]);
        let hasChanges = false;

        for (const endpoint of [...allEndpoints].sort()) {
          const old = map1.get(endpoint);
          const newer = map2.get(endpoint);

          if (!old) {
            info(`\n${endpoint}: NEW endpoint`);
            hasChanges = true;
            continue;
          }
          if (!newer) {
            warn(`\n${endpoint}: REMOVED endpoint`);
            hasChanges = true;
            continue;
          }

          // Compare response schemas (primary response)
          const oldResponse = old.responseSchemas
            ? Object.values(old.responseSchemas)[0]
            : undefined;
          const newResponse = newer.responseSchemas
            ? Object.values(newer.responseSchemas)[0]
            : undefined;

          if (oldResponse && newResponse) {
            const diff = detectBreakingChanges(oldResponse, newResponse);
            if (diff.breakingChanges.length > 0 || diff.nonBreakingChanges.length > 0) {
              hasChanges = true;
              process.stdout.write(formatDiff(diff, endpoint) + '\n');
            }
          }
        }

        if (!hasChanges) {
          info('No differences found between the two sessions.');
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ========== agent-report ==========
  program
    .command('agent-report')
    .description('Analyze agent traffic patterns and API friendliness')
    .argument('[session-id]', 'Session ID (defaults to latest completed)')
    .option('--name <name>', 'Session name')
    .option('--explain', 'Use LLM for richer explanations')
    .action(async (sessionId: string | undefined, opts: Record<string, string | boolean | undefined>) => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);
        const schemaRepo = new AggregatedSchemaRepository(db);

        // Resolve session (same pattern as export command)
        const targetId = resolveSessionId(sessions, sessionId, opts['name'] as string | undefined, 'latest');
        const session = sessions.getSession(targetId)!;

        // Validate consumer type
        if (session.consumer !== 'agent') {
          throw new SpecwatchError(
            'agent-report requires a session captured with --consumer agent',
            'Start a session with: specwatch start <url> --consumer agent',
          );
        }

        // Get aggregated schemas
        const schemas = schemaRepo.listBySessionLatestSnapshot(targetId);
        if (schemas.length === 0) {
          throw new SpecwatchError(
            'No schemas found for this session.',
            'Run aggregation first: specwatch aggregate',
          );
        }

        // Run analysis — use JSON-RPC completeness for MCP-style sessions
        const sequenceAnalysis = detectSequences(db, targetId);
        const sampleRepo = new SampleRepository(db);
        const samples = sampleRepo.listBySession(targetId);
        const completenessReport = isJsonRpcSession(samples)
          ? analyzeJsonRpcCompleteness(samples)
          : analyzeCompleteness(schemas);

        // Detect phases from sample timing
        const phaseAnalysis = detectPhases(samples);

        // Investigate redundant calls
        let investigationReport = investigateRedundantCalls(
          samples,
          sequenceAnalysis.redundantCalls,
          phaseAnalysis,
        );

        // LLM-enhanced explanations
        if (opts['explain']) {
          const llmConfig = loadLlmConfig();
          if (!llmConfig) {
            warn('LLM not configured — set LLM_BASE_URL and LLM_API_KEY (or add a .env file). Continuing with heuristic explanations.');
          } else {
            investigationReport = await explainAllInvestigations(investigationReport, llmConfig);
          }
        }

        // Format and output
        const sessionName = session.name ?? session.id.slice(0, 8);
        const output = formatAgentReport(
          sessionName,
          sequenceAnalysis,
          completenessReport,
          session.sampleCount,
          phaseAnalysis,
          investigationReport,
          samples,
        );
        process.stdout.write(output + '\n');
      } catch (err) {
        handleError(err);
      }
    });

  // ========== investigate ==========
  program
    .command('investigate')
    .description('Deep-dive investigation of redundant API calls')
    .argument('[session-id]', 'Session ID (defaults to latest completed)')
    .option('--tool <name>', 'Investigate a specific tool/operation')
    .option('--name <name>', 'Session name')
    .option('--explain', 'Use LLM for richer explanations')
    .action(async (sessionId: string | undefined, opts: Record<string, string | boolean | undefined>) => {
      try {
        const db = getDatabase();
        const sessions = new SessionRepository(db);

        // Resolve session (same pattern as export command)
        const targetId = resolveSessionId(sessions, sessionId, opts['name'] as string | undefined, 'latest');
        const session = sessions.getSession(targetId)!;

        // Validate consumer type
        if (session.consumer !== 'agent') {
          throw new SpecwatchError(
            'investigate requires a session captured with --consumer agent',
            'Start a session with: specwatch start <url> --consumer agent',
          );
        }

        // Load samples
        const sampleRepo = new SampleRepository(db);
        const samples = sampleRepo.listBySession(targetId);
        if (samples.length === 0) {
          throw new SpecwatchError(
            'No samples found for this session.',
            'Capture some traffic first.',
          );
        }

        // Run analysis
        const sequenceAnalysis = detectSequences(db, targetId);
        const phaseAnalysis = detectPhases(samples);

        // Load LLM config if --explain
        let llmConfig: ReturnType<typeof loadLlmConfig> = undefined;
        if (opts['explain']) {
          llmConfig = loadLlmConfig();
          if (!llmConfig) {
            warn('LLM not configured — set LLM_BASE_URL and LLM_API_KEY (or add a .env file). Continuing with heuristic explanations.');
          }
        }

        if (opts['tool']) {
          // Investigate a specific tool/operation
          let investigation = investigateOperation(samples, opts['tool'] as string, phaseAnalysis);
          if (investigation.occurrences.length === 0) {
            throw new SpecwatchError(
              `No calls found for operation "${opts['tool']}"`,
              'Check the operation key with: specwatch agent-report',
            );
          }
          if (llmConfig) {
            const enhanced = await explainAllInvestigations(
              { sessionId: session.id, investigations: [investigation] },
              llmConfig,
            );
            investigation = enhanced.investigations[0];
          }
          process.stdout.write(formatInvestigation(investigation) + '\n');
        } else {
          // Investigate all redundant calls
          if (sequenceAnalysis.redundantCalls.length === 0) {
            info('No redundant calls detected in this session.');
            return;
          }

          let report = investigateRedundantCalls(
            samples,
            sequenceAnalysis.redundantCalls,
            phaseAnalysis,
          );

          if (llmConfig) {
            report = await explainAllInvestigations(report, llmConfig);
          }

          for (const investigation of report.investigations) {
            process.stdout.write(formatInvestigation(investigation) + '\n\n');
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  return program;
}
