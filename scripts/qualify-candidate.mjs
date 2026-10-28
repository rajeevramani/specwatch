#!/usr/bin/env node
/**
 * Local source-package rehearsal, NOT release/tag/publication authority.
 * Usage: node scripts/qualify-candidate.mjs --output /absolute/new/private-directory
 * Builds/packs this source, installs dependencies in the owned output directory,
 * exercises a loopback fixture, and retains report.json plus exact artifacts/logs.
 * Caller must authorize installation/build scripts and owned temporary resources.
 * Use the candidate's supported Node runtime; qualification is platform-specific.
 * This harness makes no Windows or interactive-TUI claim.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, delimiter, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CHECKS = Object.freeze([
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
]);

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1] || !isAbsolute(argv[1])) {
    throw new Error('Use --output with one fresh absolute directory.');
  }
  return { output: resolve(argv[1]) };
}

export function summarizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length !== REQUIRED_CHECKS.length) {
    throw new Error('Qualification check set is incomplete.');
  }
  const names = new Set();
  for (const check of checks) {
    if (!check || !REQUIRED_CHECKS.includes(check.name) || names.has(check.name)) {
      throw new Error('Qualification check names are invalid or duplicated.');
    }
    names.add(check.name);
    if (check.status !== 'passed')
      throw new Error('Qualification contains a failed or skipped check.');
  }
  return { status: 'passed', total: checks.length };
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
async function until(predicate, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await pause(25);
  }
}
async function jsonFile(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return server.address().port;
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections();
  if (server.listening)
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}
async function terminateOwned(proc) {
  if (!proc || exited(proc) || !proc.pid) return;
  proc.kill('SIGTERM');
  try {
    await until(() => exited(proc), 'owned SIGTERM cleanup', 2000);
  } catch {
    proc.kill('SIGKILL');
    await until(() => exited(proc), 'owned SIGKILL cleanup', 2000);
  }
}
function launch(executable, args, options) {
  const proc = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '',
    error;
  proc.stdout.on('data', (bytes) => {
    stdout += bytes.toString();
  });
  proc.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  proc.on('error', (value) => {
    error = value;
  });
  return { proc, stdout: () => stdout, stderr: () => stderr, error: () => error };
}
async function sourceInventory(root) {
  const files = [];
  const extensions = /\.(?:ts|tsx|mjs|js|json|md|ya?ml|snap)$/;
  async function walk(dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && extensions.test(item.name)) files.push(path);
    }
  }
  for (const folder of ['src', 'tests', 'scripts', 'skills']) {
    try {
      await walk(join(root, folder));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const name of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsup.config.ts',
    'vitest.config.ts',
    'eslint.config.js',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ]) {
    try {
      if ((await stat(join(root, name))).isFile()) files.push(join(root, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return Promise.all(
    [...new Set(files)]
      .sort()
      .map(async (path) => ({ path: relative(root, path), sha256: hash(await readFile(path)) })),
  );
}
function sourceHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}
function dereference(doc, schema) {
  const seen = new Set();
  while (schema?.$ref) {
    assert(!seen.has(schema.$ref), 'Cyclic response reference in fixture output');
    seen.add(schema.$ref);
    assert(schema.$ref.startsWith('#/'));
    schema = schema.$ref
      .slice(2)
      .split('/')
      .reduce((value, key) => value[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return schema;
}

export async function qualifyCandidate(output) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Non-recursive creation is the ownership boundary. Never overwrite a prior run.
  await mkdir(output, { mode: 0o700 });
  const home = join(output, 'store');
  const consumer = join(output, 'consumer');
  const logs = join(output, 'logs');
  const packDir = join(output, 'pack');
  for (const dir of [consumer, logs, packDir]) await mkdir(dir, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''),
    SPECWATCH_HOME: home,
    NO_COLOR: '1',
  };
  const report = {
    schema_version: 'specwatch.qualification.v1',
    kind: 'source-package-rehearsal',
    status: 'running',
    identity: {
      source_head: sourceHead(root),
      runtime: {
        executable: process.execPath,
        version: process.version,
        abi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
      },
    },
    paths: { output, home, consumer },
    checks: [],
    commands: [],
    artifacts: {},
    limits: [
      'No release/tag/publication qualification',
      'Synthetic loopback traffic only',
      'Known correctness/runtime-policy conditions are not waived',
      'Standalone skill is separately source-distributed',
    ],
  };
  let child, upstream;
  let installedCli, Database, yaml;
  const sentinel = 'HEADER_ONLY_QUALIFICATION_SENTINEL';
  const body = JSON.stringify({ id: 7, label: 'fixture', available: true });
  const absent = (text, label) => assert(!text.includes(sentinel), `Header value reached ${label}`);
  async function persist() {
    await jsonFile(join(output, 'report.json'), report);
  }
  async function check(name, fn) {
    try {
      await fn();
      report.checks.push({ name, status: 'passed' });
      await persist();
    } catch (error) {
      report.checks.push({ name, status: 'failed', detail: error.message });
      throw error;
    }
  }
  async function command(executable, args, name, cli = false, timeout = 120000) {
    const active = launch(executable, args, { env, cwd: root });
    try {
      await until(
        () => {
          if (active.error()) throw active.error();
          return exited(active.proc);
        },
        name,
        timeout,
      );
      const record = {
        executable,
        args,
        exit: active.proc.exitCode,
        stdout: active.stdout(),
        stderr: active.stderr(),
      };
      if (cli) report.commands.push(record);
      await writeFile(join(logs, name + '.stdout.txt'), record.stdout);
      await writeFile(join(logs, name + '.stderr.txt'), record.stderr);
      assert.equal(active.proc.signalCode, null, `${name} signaled`);
      assert.equal(record.exit, 0, `${name} failed; see owned logs`);
      if (cli) {
        absent(record.stdout, name);
        absent(record.stderr, name + ' stderr');
      }
      return record;
    } finally {
      await terminateOwned(active.proc);
    }
  }
  async function cli(args, name) {
    return command(installedCli, args, name, true, 10000);
  }
  async function artifact(name, record) {
    const path = join(output, name + '.txt');
    await writeFile(path, record.stdout);
    report.artifacts[name] = path;
    return path;
  }
  async function rows(table) {
    const db = new Database(join(home, 'specwatch.db'), { readonly: true, fileMustExist: true });
    try {
      return db.prepare(`SELECT * FROM ${table}`).all();
    } finally {
      db.close();
    }
  }
  try {
    await check('build', async () => {
      await command('npm', ['run', 'build'], 'build');
    });
    const inventory = await sourceInventory(root);
    await jsonFile(join(output, 'source-inventory.json'), inventory);
    report.identity.source_inventory_sha256 = hash(
      await readFile(join(output, 'source-inventory.json')),
    );
    await check('pack', async () => {
      const packed = await command(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
        'pack',
      );
      const data = JSON.parse(packed.stdout);
      assert.equal(data.length, 1);
      assert.equal(dirname(data[0].filename), '.');
      report.paths.tarball = join(packDir, data[0].filename);
      report.identity.tarball_sha256 = hash(await readFile(report.paths.tarball));
      report.package_files = data[0].files.map((file) => file.path);
      assert(report.package_files.includes('dist/index.js'));
    });
    await check('install', async () => {
      const installed = await command(
        'npm',
        ['install', '--prefix', consumer, '--no-audit', '--no-fund', report.paths.tarball],
        'install',
      );
      report.engine_warnings = installed.stderr.includes('EBADENGINE');
      report.identity.consumer_lock_sha256 = hash(
        await readFile(join(consumer, 'package-lock.json')),
      );
      installedCli = join(consumer, 'node_modules', '.bin', 'specwatch');
      const require = createRequire(join(consumer, 'package.json'));
      Database = require('better-sqlite3');
      yaml = require('js-yaml');
    });
    await check('identity', async () => {
      report.identity.cli_sha256 = hash(await readFile(installedCli));
      assert.equal(report.identity.cli_sha256, hash(await readFile(join(root, 'dist/index.js'))));
      assert.equal(report.identity.tarball_sha256, hash(await readFile(report.paths.tarball)));
      report.identity.skill_sha256 = hash(await readFile(join(root, 'skills/learn-api/SKILL.md')));
      const db = new Database(':memory:');
      db.close();
      report.identity.native_addon_loaded = true;
      const current = await sourceInventory(root);
      assert.deepEqual(current, inventory, 'Source inputs changed during pack/install');
    });
    await check('shim', async () => {
      const version = await cli(['--version'], 'shim-version');
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      assert.equal(version.stdout.trim(), pkg.version);
      report.identity.version = version.stdout.trim();
      const help = await cli(['--help'], 'shim-help');
      assert(help.stdout.includes('start'));
    });
    const seen = [];
    upstream = createServer((request, response) => {
      seen.push(request.headers);
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': [`session=${sentinel}`],
        Location: `/next/${sentinel}`,
        'X-Upstream-Context': sentinel,
      });
      response.end(body);
    });
    const upstreamPort = await listen(upstream);
    const reservation = createServer();
    const proxyPort = await listen(reservation);
    await close(reservation);
    const startArgs = [
      'start',
      `http://127.0.0.1:${upstreamPort}`,
      '--port',
      String(proxyPort),
      '--name',
      'api-learning',
      '--max-samples',
      '200',
      '--consumer',
      'agent',
    ];
    const active = launch(installedCli, startArgs, { env, cwd: root });
    child = active.proc;
    await check('readiness', async () => {
      await until(() => {
        if (active.error()) throw active.error();
        if (exited(child)) throw new Error('Installed capture exited before readiness');
        return active.stderr().includes('Specwatch proxy started');
      }, 'installed stderr readiness');
    });
    await check('forwarding', async () => {
      const paths = ['/items', '/catalog', '/items', '/catalog', '/items', '/catalog'];
      for (const [index, path] of paths.entries()) {
        const authorization = `${index % 2 ? 'Basic' : 'Bearer'} ${sentinel}`;
        const result = await new Promise((done, reject) => {
          const request = get(
            `http://127.0.0.1:${proxyPort}${path}`,
            {
              agent: false,
              headers: {
                Authorization: authorization,
                Cookie: `session=${sentinel}`,
                'X-API-Key': sentinel,
                'X-Shared-Context': sentinel,
              },
            },
            (response) => {
              let bytes = '';
              response.on('data', (chunk) => {
                bytes += chunk.toString();
              });
              response.on('error', reject);
              response.on('end', () =>
                done({ status: response.statusCode, headers: response.headers, bytes }),
              );
            },
          );
          request.setTimeout(5000, () =>
            request.destroy(new Error('Owned fixture request timeout')),
          );
          request.on('error', reject);
        });
        assert.equal(result.status, 200);
        assert.equal(result.bytes, body);
        assert.equal(result.headers['x-upstream-context'], sentinel);
        assert.equal(result.headers.location, `/next/${sentinel}`);
        assert.deepEqual(result.headers['set-cookie'], [`session=${sentinel}`]);
        assert.equal(seen[index].authorization, authorization);
        assert.equal(seen[index]['x-shared-context'], sentinel);
        assert.equal(seen[index].cookie, `session=${sentinel}`);
        assert.equal(seen[index]['x-api-key'], sentinel);
      }
      assert.equal(seen.length, 6);
      const deadline = Date.now() + 10000;
      while ((await rows('samples')).length !== 6) {
        if (Date.now() >= deadline) throw new Error('Six samples were not persisted');
        await pause(25);
      }
      report.requests = seen.length;
    });
    await check('shutdown', async () => {
      child.kill('SIGINT');
      await until(() => exited(child), 'owned installed capture shutdown');
      const record = {
        executable: installedCli,
        args: startArgs,
        exit: child.exitCode,
        stdout: active.stdout(),
        stderr: active.stderr(),
      };
      report.commands.push(record);
      await writeFile(join(logs, 'start.stdout.txt'), record.stdout);
      await writeFile(join(logs, 'start.stderr.txt'), record.stderr);
      assert.equal(child.signalCode, null);
      assert.equal(child.exitCode, 0);
      absent(record.stdout, 'start stdout');
      absent(record.stderr, 'start stderr');
    });
    await check('store', async () => {
      const db = new Database(join(home, 'specwatch.db'), { readonly: true, fileMustExist: true });
      try {
        assert.equal(db.pragma('user_version', { simple: true }), 4);
        for (const table of ['samples', 'aggregated_schemas']) {
          const entries = db.prepare(`SELECT request_headers,response_headers FROM ${table}`).all();
          assert(entries.length > 0);
          for (const row of entries)
            for (const encoded of Object.values(row)) {
              assert(encoded !== null);
              absent(encoded, table + ' headers');
              for (const header of JSON.parse(encoded)) {
                assert.deepEqual(
                  Object.keys(header).sort(),
                  header.authSchemes ? ['authSchemes', 'name'] : ['name'],
                );
                assert.equal(header.name, header.name.toLowerCase());
                if (header.authSchemes) {
                  assert.equal(header.name, 'authorization');
                  assert(
                    header.authSchemes.every((scheme) => scheme === 'basic' || scheme === 'bearer'),
                  );
                }
              }
            }
        }
        assert.equal(db.prepare('SELECT count(*) n FROM samples').get().n, 6);
        const snapshots = db
          .prepare('SELECT path,snapshot,sample_count FROM aggregated_schemas ORDER BY path')
          .all();
        assert.deepEqual(
          snapshots.map((row) => [row.path, row.snapshot, row.sample_count]),
          [
            ['/catalog', 1, 3],
            ['/items', 1, 3],
          ],
        );
        assert.equal(db.prepare('SELECT status FROM sessions').get().status, 'completed');
      } finally {
        db.close();
      }
      for (const name of await readdir(home))
        absent((await readFile(join(home, name))).toString(), 'fresh store bytes');
    });
    await check('skill', async () => {
      const skill = await readFile(join(root, 'skills/learn-api/SKILL.md'), 'utf8');
      assert(skill.startsWith('---\n'));
      assert(skill.includes('--include-metadata'));
      await cli(['sessions', 'list'], 'skill-sessions');
      await cli(['snapshots', '--name', 'api-learning'], 'skill-snapshots');
      const path = join(output, 'skill-openapi.yaml');
      await cli(
        ['export', '--name', 'api-learning', '--include-metadata', '--output', path],
        'skill-export',
      );
      const raw = await readFile(path, 'utf8');
      absent(raw, 'skill artifact');
      const doc = yaml.load(raw);
      assert.equal(doc.openapi, '3.1.0');
      assert.deepEqual(Object.keys(doc.paths).sort(), ['/catalog', '/items']);
      for (const route of Object.values(doc.paths))
        assert.equal(route.get['x-specwatch-sample-count'], 3);
      report.artifacts.skill = path;
    });
    for (const version of ['3.1', '3.0'])
      for (const metadata of [false, true]) {
        const label = `oas${version.replace('.', '')}_metadata_${metadata}`;
        await check(label, async () => {
          const args = ['export', '--name', 'api-learning', '--json', '--openapi-version', version];
          if (metadata) args.push('--include-metadata');
          const result = await cli(args, label);
          await artifact(label, result);
          const doc = JSON.parse(result.stdout);
          assert.equal(doc.openapi, version === '3.0' ? '3.0.3' : '3.1.0');
          assert.deepEqual(Object.keys(doc.paths).sort(), ['/catalog', '/items']);
          for (const route of Object.values(doc.paths)) {
            const op = route.get;
            assert(
              op.parameters.some(
                (p) => p.name === 'x-shared-context' && p.in === 'header' && !('example' in p),
              ),
            );
            if (metadata) {
              assert.equal(op['x-specwatch-sample-count'], 3);
              assert.equal(typeof op['x-specwatch-confidence'], 'number');
            } else assert(!('x-specwatch-sample-count' in op));
            const schema = dereference(doc, op.responses['200'].content['application/json'].schema);
            assert.equal(schema.properties.id.type, 'integer');
            assert.equal(schema.properties.label.type, 'string');
            assert.equal(schema.properties.available.type, 'boolean');
          }
          assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
          assert.equal(doc.components.securitySchemes.basicAuth.scheme, 'basic');
          assert.equal(doc.components.securitySchemes.apiKeyAuth.type, 'apiKey');
          assert.equal('x-specwatch-global-headers' in doc, metadata);
        });
      }
    await check('raw_json', async () => {
      const result = await cli(
        ['export', '--name', 'api-learning', '--format', 'json'],
        'raw_json',
      );
      await artifact('raw_json', result);
      const raw = JSON.parse(result.stdout);
      assert.equal(raw.schemas.length, 2);
      for (const schema of raw.schemas)
        for (const headers of [schema.requestHeaders, schema.responseHeaders]) {
          assert(Array.isArray(headers));
          for (const header of headers)
            assert.deepEqual(
              Object.keys(header).sort(),
              header.authSchemes ? ['authSchemes', 'name'] : ['name'],
            );
        }
    });
    await check('agent_json', async () => {
      const result = await cli(['agent-report', '--name', 'api-learning'], 'agent_json');
      await artifact('agent_json', result);
      const evidence = JSON.parse(result.stdout);
      assert.equal(evidence.schema_version, 'specwatch.agent_evidence.v1');
      assert.equal(evidence.operations.length, 2);
      assert.equal(
        evidence.operations.reduce((sum, op) => sum + op.observed_count, 0),
        6,
      );
    });
    await check('agent_human', async () => {
      const result = await cli(
        ['agent-report', '--name', 'api-learning', '--human'],
        'agent_human',
      );
      await artifact('agent_human', result);
      assert(result.stdout.includes('Agent-Friendliness Report'));
    });
    await check('investigation', async () => {
      const result = await cli(
        ['investigate', '--name', 'api-learning', '--json'],
        'investigation',
      );
      await artifact('investigation', result);
      const investigation = JSON.parse(result.stdout);
      assert.equal(investigation.schema_version, 'specwatch.investigation.v1');
      assert(Array.isArray(investigation.investigations));
    });
    assert.deepEqual(await sourceInventory(root), inventory, 'Source changed during qualification');
    assert.equal(hash(await readFile(report.paths.tarball)), report.identity.tarball_sha256);
    assert.equal(hash(await readFile(installedCli)), report.identity.cli_sha256);
    assert.equal(hash(await readFile(join(root, 'dist/index.js'))), report.identity.cli_sha256);
    assert.equal(
      hash(await readFile(join(consumer, 'package-lock.json'))),
      report.identity.consumer_lock_sha256,
    );
    const summary = summarizeChecks(report.checks);
    report.status = summary.status;
    report.total = summary.total;
    await persist();
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    await persist();
    throw error;
  } finally {
    try {
      await terminateOwned(child);
      await close(upstream);
    } catch (error) {
      report.status = 'failed';
      report.cleanup_error = error.message;
      await persist();
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help)
      console.log(
        'Usage: node scripts/qualify-candidate.mjs --output /absolute/new/private-directory',
      );
    else {
      const report = await qualifyCandidate(options.output);
      console.log(
        JSON.stringify({
          status: report.status,
          checks: report.total,
          report: join(options.output, 'report.json'),
          tarball_sha256: report.identity.tarball_sha256,
        }),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
