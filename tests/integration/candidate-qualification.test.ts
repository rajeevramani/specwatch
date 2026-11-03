/**
 * Implementation-blind S4 contract. Authoring reads are limited to package.json,
 * vitest.config.ts and header-privacy-cli.test.ts. No production/harness imports.
 * Only this test's mechanical scratch copy is built, packed or installed.
 * The parent runs this target after implementing scripts/qualify-candidate.mjs.
 */
import { expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRATCH = process.env.TMPDIR ?? tmpdir();
const SENTINEL = 'HEADER_ONLY_QUALIFICATION_SENTINEL';
const CHECKS = [
  'build',
  'pack',
  'install',
  'identity',
  'shim',
  'readiness',
  'forwarding',
  'shutdown',
  'store',
  'skill',
  'oas31_metadata_false',
  'oas31_metadata_true',
  'oas30_metadata_false',
  'oas30_metadata_true',
  'raw_json',
  'agent_json',
  'agent_human',
  'investigation',
];
const ARTIFACTS = [
  'skill',
  'oas31_metadata_false',
  'oas31_metadata_true',
  'oas30_metadata_false',
  'oas30_metadata_true',
  'raw_json',
  'agent_json',
  'agent_human',
  'investigation',
];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
type Document = Record<string, any>;

function isolatedSource() {
  mkdirSync(SCRATCH, { recursive: true });
  const base = mkdtempSync(join(SCRATCH, 'specwatch-candidate-contract-'));
  const source = join(base, 'source');
  mkdirSync(source);
  try {
    // Copy only the approved build inputs; never enumerate or inspect src/scripts.
    for (const item of [
      'src',
      'scripts/qualify-candidate.mjs',
      'skills/learn-api/SKILL.md',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsup.config.ts',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
    ]) {
      mkdirSync(dirname(join(source, item)), { recursive: true });
      cpSync(join(ROOT, item), join(source, item), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(source, 'node_modules'), 'dir');
    return { base, source, output: join(base, 'output') };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error; // Missing harness is a failure, never a skip.
  }
}

async function runHarness(source: string, args: string[], timeout = 120_000) {
  const child = spawn(process.execPath, [join(source, 'scripts/qualify-candidate.mjs'), ...args], {
    cwd: source,
    // Keep every incidental npm/CLI home inside the owned scratch tree as well.
    env: {
      ...process.env,
      HOME: join(source, '..', 'launcher-home'),
      SPECWATCH_HOME: join(source, '..', 'launcher-store'),
      NO_COLOR: '1',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const signalOwnedGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    signalOwnedGroup('SIGTERM');
    escalation = setTimeout(() => signalOwnedGroup('SIGKILL'), 2_000);
  }, timeout);
  try {
    const result = await new Promise<{ exit: number | null; signal: NodeJS.Signals | null }>(
      (done, reject) => {
        child.once('error', reject);
        child.once('close', (exit, signal) => done({ exit, signal }));
      },
    );
    expect(timedOut, `harness deadline: ${stderr}`).toBe(false);
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    // Only our detached process group; no process-name/global kills.
    signalOwnedGroup('SIGKILL');
  }
}

function ownedPath(path: unknown, directory: string): string {
  expect(typeof path).toBe('string');
  expect(isAbsolute(path as string)).toBe(true);
  const actual = realpathSync(path as string);
  const rel = relative(realpathSync(directory), actual);
  expect(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)).toBe(true);
  return actual;
}

function noSecret(value: string | Buffer, label: string) {
  expect(value.includes(SENTINEL), `${label}: header-only sentinel must not reach a sink`).toBe(
    false,
  );
}

function metadata(value: unknown) {
  expect(Array.isArray(value)).toBe(true);
  for (const header of value as Document[]) {
    expect(Object.keys(header).sort()).toEqual(
      header.authSchemes === undefined ? ['name'] : ['authSchemes', 'name'],
    );
    expect(typeof header.name).toBe('string');
    if (header.authSchemes !== undefined) {
      expect(header.name).toBe('authorization');
      expect(Array.isArray(header.authSchemes)).toBe(true);
      for (const scheme of header.authSchemes) expect(['bearer', 'basic']).toContain(scheme);
    }
  }
}

function schemaAt(doc: Document, schema: Document): Document {
  if (!schema.$ref) return schema;
  expect(schema.$ref).toMatch(/^#\//);
  return schema.$ref
    .slice(2)
    .split('/')
    .reduce(
      (node: Document, key: string) => node[key.replace(/~1/g, '/').replace(/~0/g, '~')],
      doc,
    );
}

function openapi(doc: Document, version: string) {
  expect(doc.openapi).toBe(version);
  const security = Object.values(doc.components.securitySchemes);
  for (const scheme of ['bearer', 'basic']) {
    expect(security).toContainEqual(expect.objectContaining({ type: 'http', scheme }));
  }
  expect(security).toContainEqual(
    expect.objectContaining({
      type: 'apiKey',
      in: 'header',
      name: expect.stringMatching(/^x-api-key$/i),
    }),
  );
  for (const path of ['/items', '/catalog']) {
    const operation = doc.paths[path].get;
    const parameter = (operation.parameters ?? []).find(
      (p: Document) => p.in === 'header' && p.name === 'x-shared-context',
    );
    expect(parameter).toMatchObject({
      name: 'x-shared-context',
      in: 'header',
      required: false,
      schema: { type: 'string' },
    });
    expect(parameter).not.toHaveProperty('example');
    expect(parameter).not.toHaveProperty('examples');
    const schema = schemaAt(doc, operation.responses['200'].content['application/json'].schema);
    expect(schema.properties).toMatchObject({
      id: { type: 'integer' },
      label: { type: 'string' },
      available: { type: 'boolean' },
    });
  }
}

it('qualifies the exact isolated source tarball through a clean installed shim and retained evidence', async () => {
  const { base, source, output } = isolatedSource();
  try {
    const result = await runHarness(source, ['--output', output]);
    expect(result.signal, result.stderr).toBeNull();
    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0);
    noSecret(result.stdout, 'harness stdout');
    noSecret(result.stderr, 'harness stderr');
    const reportBytes = readFileSync(join(output, 'report.json'));
    noSecret(reportBytes, 'report');
    const report = JSON.parse(reportBytes.toString());
    expect(report).toMatchObject({
      schema_version: 'specwatch.qualification.v1',
      kind: 'source-package-rehearsal',
      status: 'passed',
      identity: {
        version: json(join(source, 'package.json')).version,
        runtime: {
          version: process.version,
          abi: process.versions.modules,
          platform: process.platform,
          arch: process.arch,
        },
      },
    });
    expect(report.paths.output).toBe(output);
    expect(report.paths.consumer).toBe(join(output, 'consumer'));
    const consumer = ownedPath(report.paths.consumer, output);
    const home = ownedPath(report.paths.home, output);
    const tarball = ownedPath(report.paths.tarball, output);
    for (const field of [
      'tarball_sha256',
      'cli_sha256',
      'source_inventory_sha256',
      'skill_sha256',
      'consumer_lock_sha256',
    ])
      expect(report.identity[field], field).toMatch(/^[a-f0-9]{64}$/);
    expect(report.identity.tarball_sha256).toBe(digest(readFileSync(tarball)));
    expect(report.identity.consumer_lock_sha256).toBe(
      digest(readFileSync(join(consumer, 'package-lock.json'))),
    );
    expect(report.identity.skill_sha256).toBe(
      digest(readFileSync(join(source, 'skills/learn-api/SKILL.md'))),
    );
    const installed = join(consumer, 'node_modules/specwatch');
    const installedPackage = json(join(installed, 'package.json'));
    expect(installedPackage.version).toBe(report.identity.version);
    const cli = join(installed, installedPackage.bin.specwatch);
    const cliBytes = readFileSync(cli);
    expect(report.identity.cli_sha256).toBe(digest(cliBytes));
    // tar is only used to read our own package artifact, never production source.
    const packedCli = execFileSync('tar', [
      '-xOf',
      tarball,
      `package/${installedPackage.bin.specwatch.replace(/^\.\//, '')}`,
    ]);
    expect(digest(packedCli)).toBe(digest(cliBytes));
    const members = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    expect(members.split('\n').some((name) => name.startsWith('package/skills/'))).toBe(false);
    expect(realpathSync(join(consumer, 'node_modules/.bin/specwatch'))).toBe(realpathSync(cli));
    // Prove the clean install is not a link back into the shared toolchain.
    ownedPath(cli, consumer);
    expect(report.checks).toHaveLength(CHECKS.length);
    expect(report.checks.map((check: Document) => check.name).sort()).toEqual([...CHECKS].sort());
    for (const check of report.checks) expect(check.status, check.name).toBe('passed');
    expect(Array.isArray(report.commands)).toBe(true);
    expect(report.commands.length).toBeGreaterThanOrEqual(9);
    for (const command of report.commands) {
      expect(command.executable).toBe(join(consumer, 'node_modules/.bin/specwatch'));
      expect(Array.isArray(command.args)).toBe(true);
      expect(command.args.every((arg: unknown) => typeof arg === 'string')).toBe(true);
      expect(command.exit).toBe(0);
      expect(typeof command.stdout).toBe('string');
      expect(typeof command.stderr).toBe('string');
      noSecret(command.stdout, 'command stdout');
      noSecret(command.stderr, 'command stderr');
    }
    expect(Object.keys(report.artifacts).sort()).toEqual([...ARTIFACTS].sort());
    const artifacts: Record<string, string> = {};
    for (const key of ARTIFACTS) {
      artifacts[key] = readFileSync(ownedPath(report.artifacts[key], output), 'utf8');
      noSecret(artifacts[key], key);
      expect(artifacts[key].trim().length, key).toBeGreaterThan(0);
    }
    const skill = load(artifacts.skill);
    expect(skill).not.toBeNull();
    expect(typeof skill).toBe('object');
    expect(Array.isArray(skill)).toBe(false);
    for (const [prefix, version] of [
      ['oas31', '3.1.0'],
      ['oas30', '3.0.3'],
    ]) {
      for (const setting of ['false', 'true'])
        openapi(JSON.parse(artifacts[`${prefix}_metadata_${setting}`]), version);
    }
    expect(JSON.parse(artifacts.agent_json).schema_version).toBe('specwatch.agent_evidence.v1');
    const investigation = JSON.parse(artifacts.investigation);
    expect(investigation.schema_version).toBe('specwatch.investigation.v1');
    expect(Array.isArray(investigation.investigations)).toBe(true);
    expect(artifacts.agent_human).toContain('Agent-Friendliness Report');
    const raw = JSON.parse(artifacts.raw_json);
    expect(Array.isArray(raw.schemas)).toBe(true);
    expect(raw.schemas.length).toBeGreaterThanOrEqual(2);
    for (const schema of raw.schemas) {
      metadata(schema.requestHeaders);
      metadata(schema.responseHeaders);
    }
    // Read-only inspection of this exact owned store, not a discovered/user DB.
    const db = new Database(join(home, 'specwatch.db'), { readonly: true, fileMustExist: true });
    try {
      const samples = db
        .prepare(
          'SELECT http_method AS method, path, request_headers, response_headers FROM samples',
        )
        .all() as Document[];
      expect(samples).toHaveLength(6);
      for (const path of ['/items', '/catalog'])
        expect(samples.filter((row) => row.method === 'GET' && row.path === path)).toHaveLength(3);
      for (const table of ['samples', 'aggregated_schemas']) {
        const rows = db
          .prepare(`SELECT request_headers, response_headers FROM ${table}`)
          .all() as Document[];
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          for (const field of ['request_headers', 'response_headers']) {
            noSecret(row[field], `${table}.${field}`);
            metadata(JSON.parse(row[field]));
          }
          expect(JSON.parse(row.request_headers)).toContainEqual(
            expect.objectContaining({ name: 'x-shared-context' }),
          );
        }
      }
    } finally {
      db.close();
    }
    for (const name of readdirSync(home)) {
      const file = join(home, name);
      if (statSync(file).isFile()) noSecret(readFileSync(file), 'fresh store bytes');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 135_000);

it('rejects malformed, unknown and duplicate arguments without touching existing output', async () => {
  const { base, source, output } = isolatedSource();
  try {
    mkdirSync(output);
    const sentinel = join(output, 'preserve-me.txt');
    const original = Buffer.from('existing output belongs to its caller\n');
    writeFileSync(sentinel, original);
    const variants = [
      [],
      ['--output'],
      ['--unknown', output],
      ['--output', 'relative-output'],
      ['--output', ''],
      ['--output', output, '--output', output],
      ['--output', output, '--unknown'],
      ['--output', output, 'extra'],
      ['--output', output],
    ];
    for (const args of variants) {
      const result = await runHarness(source, args, 5_000);
      expect(result.signal, JSON.stringify(args)).toBeNull();
      expect(result.exit, `${JSON.stringify(args)}: ${result.stderr}`).not.toBe(0);
      expect(readFileSync(sentinel)).toEqual(original);
      expect(readdirSync(output)).toEqual(['preserve-me.txt']);
    }
    // Invalid argv must also reject when the requested output does not yet exist.
    const fresh = join(base, 'invalid-fresh');
    const rejected = await runHarness(source, ['--output', fresh, '--unknown'], 5_000);
    expect(rejected.signal).toBeNull();
    expect(rejected.exit).not.toBe(0);
    expect(readdirSync(base)).not.toContain('invalid-fresh');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 65_000);
