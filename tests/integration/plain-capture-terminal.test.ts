/**
 * Implementation-blind public CLI contract. npm pretest builds dist once;
 * this test never builds, imports production modules, or reads an existing store.
 * Python 3 with its standard-library pty module is a required CI prerequisite.
 */
import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'dist/index.js');
const BODY = JSON.stringify({ id: 7, label: 'fixture', available: true });
const SENTINEL = 'SYNTHETIC_HEADER_ONLY_terminal_b416aa';
const REQUEST_HEADERS = {
  'X-Shared-Context': SENTINEL,
  Authorization: `Bearer ${SENTINEL}`,
  Cookie: `session=${SENTINEL}`,
};
const RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
  'X-Upstream-Context': SENTINEL,
  'Set-Cookie': [`session=${SENTINEL}; HttpOnly`],
};
const PATHS = ['/items', '/catalog', '/items', '/catalog', '/items', '/catalog'];

// This preload observes the actual Node process, not Python's claimed capability.
// It does not change argv, consumer selection, or any application configuration.
const TTY_PROBE = `data:text/javascript,${encodeURIComponent(
  "process.stdout.write('\\x1eSPECWATCH_PTY:' + JSON.stringify({stdin:process.stdin.isTTY === true,stdout:process.stdout.isTTY === true,stderr:process.stderr.isTTY === true}) + '\\x1f');",
)}`;

const BRIDGE = String.raw`
import base64, errno, fcntl, json, os, pty, selectors, signal, struct, subprocess, sys, termios, time

def emit(event, **fields):
    print(json.dumps(dict(event=event, **fields)), flush=True)

child = None
fds = []
selector = selectors.DefaultSelector()
try:
    out_master, out_slave = pty.openpty()
    err_master, err_slave = pty.openpty()
    fds = [out_master, out_slave, err_master, err_slave]
    for slave in (out_slave, err_slave):
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    env = dict(os.environ)
    env.pop('CI', None)
    env['TERM'] = 'xterm-256color'
    env['SPECWATCH_HOME'] = sys.argv[1]
    child = subprocess.Popen(sys.argv[2:], stdin=out_slave, stdout=out_slave,
                             stderr=err_slave, env=env, close_fds=True)
    emit('spawn', pid=child.pid)
    os.close(out_slave)
    os.close(err_slave)
    fds = [out_master, err_master]
    for master, channel in ((out_master, 'stdout'), (err_master, 'stderr')):
        os.set_blocking(master, False)
        selector.register(master, selectors.EVENT_READ, channel)
    os.set_blocking(sys.stdin.fileno(), False)
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, 'control')
    control = b''
    deadline = time.monotonic() + 26
    stopping = None
    while True:
        now = time.monotonic()
        if child.poll() is None and (now >= deadline or (stopping is not None and now - stopping >= 2)):
            child.kill()
            if now >= deadline:
                emit('error', message='Owned terminal CLI exceeded 26-second bridge deadline')
        for key, _ in selector.select(0.05):
            if key.data == 'control':
                data = os.read(key.fd, 4096)
                control += data
                stop = not data
                while b'\n' in control:
                    line, control = control.split(b'\n', 1)
                    if line == b'stop':
                        stop = True
                if not data:
                    selector.unregister(key.fd)
                if stop and stopping is None and child.poll() is None:
                    child.send_signal(signal.SIGINT)
                    stopping = time.monotonic()
            else:
                try:
                    data = os.read(key.fd, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b''
                if data:
                    emit('data', channel=key.data, base64=base64.b64encode(data).decode('ascii'))
                else:
                    selector.unregister(key.fd)
        if child.poll() is not None and not any(k.data != 'control' for k in selector.get_map().values()):
            emit('exit', code=child.wait())
            break
except BaseException as exc:
    emit('error', message='Python 3 standard-library PTY prerequisite / bridge failure: ' + str(exc))
    sys.exit(1)
finally:
    if child is not None:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
        child.wait()
    selector.close()
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass
`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned loopback port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
}

function ownedDatabase(home: string): string | undefined {
  const paths: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        readFileSync(path).subarray(0, 16).toString() === 'SQLite format 3\0'
      )
        paths.push(path);
    }
  }
  visit(home);
  if (paths.length > 1) throw new Error('Expected exactly one database in the fresh owned store');
  return paths[0];
}

function metadata(raw: string | null, required: string[]): void {
  expect(raw).not.toBeNull();
  expect(raw).not.toContain(SENTINEL);
  const entries: unknown = JSON.parse(raw!);
  expect(Array.isArray(entries)).toBe(true);
  const headers = entries as Array<Record<string, unknown>>;
  expect(headers.map((entry) => entry.name)).toEqual(expect.arrayContaining(required));
  for (const entry of headers) {
    expect(typeof entry.name).toBe('string');
    expect(Object.keys(entry).sort()).toEqual(
      entry.authSchemes === undefined ? ['name'] : ['authSchemes', 'name'],
    );
    if (entry.name === 'authorization') expect(entry.authSchemes).toEqual(['bearer']);
    if (entry.authSchemes !== undefined) {
      expect(entry.name).toBe('authorization');
      expect(entry.authSchemes).toEqual(['bearer']);
    }
  }
}

it('default human capture stays plain in a real PTY, forwards six calls and gracefully aggregates private metadata', async () => {
  const deadline = Date.now() + 24_000;
  const home = mkdtempSync(join(tmpdir(), 'specwatch-plain-terminal-'));
  const seen: Array<{
    method: string | undefined;
    path: string | undefined;
    headers: IncomingHttpHeaders;
    body: string;
  }> = [];
  const upstream = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      seen.push({ method: request.method, path: request.url, headers: request.headers, body });
      response.writeHead(200, RESPONSE_HEADERS);
      response.end(BODY);
    });
  });
  const reservation = createServer();
  let bridge: ReturnType<typeof spawn> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let stdout = '';
  let stderr = '';
  let bridgeDiagnostics = '';
  let failure: Error | undefined;
  let bridgeClosed = false;
  let bridgeCode: number | null = null;
  let nodeCode: number | undefined;
  let nodePid: number | undefined;
  const changed = new Set<() => void>();
  const notify = () => {
    for (const listener of changed) listener();
  };
  const plain = () => {
    expect(stdout + stderr).not.toMatch(
      /\bdashboard\b|\bUptime\b|waiting\s+for\s+traffic|\ba\s+aggregate|\be\s+export|\bq\s+(?:or\b|quit\b|stop\b)|hotkeys?|keyboard shortcuts/i,
    );
    expect(stdout + stderr).not.toContain(SENTINEL);
  };
  async function until(check: () => boolean, label: string): Promise<void> {
    while (true) {
      if (failure) throw failure;
      plain();
      if (check()) return;
      if (bridgeClosed)
        throw new Error(`Terminal bridge closed before ${label}; ${bridgeDiagnostics}`);
      if (Date.now() >= deadline) throw new Error(`Terminal contract deadline: ${label}`);
      // Output wakes immediately; the short bounded timer also observes SQLite commits.
      await new Promise<void>((done) => {
        const wake = () => {
          clearTimeout(timer);
          changed.delete(wake);
          done();
        };
        const timer = setTimeout(wake, Math.min(40, Math.max(1, deadline - Date.now())));
        changed.add(wake);
      });
    }
  }
  try {
    const upstreamPort = await listen(upstream);
    const proxyPort = await listen(reservation);
    await close(reservation);
    bridge = spawn(
      'python3',
      [
        '-u',
        '-c',
        BRIDGE,
        home,
        process.execPath,
        '--import',
        TTY_PROBE,
        CLI,
        'start',
        `http://127.0.0.1:${upstreamPort}`,
        '--port',
        String(proxyPort),
        '--name',
        'plain-terminal-fixture',
      ],
      { cwd: ROOT, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    bridge.on('error', () => {
      failure = new Error(
        'Required prerequisite: python3 with standard-library pty must be executable',
      );
      notify();
    });
    bridge.stdin!.on('error', () => {
      failure ??= new Error('Owned PTY bridge control pipe closed unexpectedly');
      notify();
    });
    bridge.stderr!.on('data', (chunk: Buffer) => {
      bridgeDiagnostics += chunk.toString();
      notify();
    });
    bridge.on('close', (code) => {
      bridgeCode = code;
      bridgeClosed = true;
      notify();
    });
    lines = createInterface({ input: bridge.stdout! });
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line) as {
          event: string;
          pid?: number;
          code?: number;
          channel?: string;
          base64?: string;
          message?: string;
        };
        if (event.event === 'spawn') nodePid = event.pid;
        else if (event.event === 'exit') nodeCode = event.code;
        else if (event.event === 'error') failure = new Error(event.message);
        else if (event.event === 'data') {
          const bytes = Buffer.from(event.base64!, 'base64').toString();
          if (event.channel === 'stdout') stdout += bytes;
          else if (event.channel === 'stderr') stderr += bytes;
          else throw new Error('Unknown terminal channel');
        } else throw new Error('Unknown bridge event');
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Invalid PTY protocol');
      }
      notify();
    });
    await until(() => {
      if (nodeCode !== undefined) throw new Error('CLI exited before stderr readiness');
      return (
        stderr.includes('Specwatch proxy started') && /\x1eSPECWATCH_PTY:(.*?)\x1f/.test(stdout)
      );
    }, 'actual Node PTY capability and stderr readiness');
    await until(
      () => stderr.includes('Press Ctrl+C to stop and aggregate.'),
      'plain CLI interrupt guidance, not dashboard hotkeys',
    );
    expect(nodePid).toBeGreaterThan(0);
    expect(JSON.parse(/\x1eSPECWATCH_PTY:(.*?)\x1f/.exec(stdout)![1])).toEqual({
      stdin: true,
      stdout: true,
      stderr: true,
    });

    // No HTTP readiness probe, consumer override, or retries: exactly six approved calls.
    for (const path of PATHS) {
      const result = await new Promise<{
        status: number | undefined;
        headers: IncomingHttpHeaders;
        body: string;
      }>((done, reject) => {
        const request = get(
          `http://127.0.0.1:${proxyPort}${path}`,
          { headers: REQUEST_HEADERS, agent: false },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            response.on('error', reject);
            response.on('end', () =>
              done({ status: response.statusCode, headers: response.headers, body }),
            );
          },
        );
        const timer = setTimeout(
          () => request.destroy(new Error('Owned HTTP request deadline')),
          Math.max(1, Math.min(2_000, deadline - Date.now())),
        );
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe(BODY);
      expect(result.headers['content-type']).toBe(RESPONSE_HEADERS['Content-Type']);
      expect(result.headers['x-upstream-context']).toBe(SENTINEL);
      expect(result.headers['set-cookie']).toEqual(RESPONSE_HEADERS['Set-Cookie']);
    }
    expect(seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual(
      PATHS.map((path) => ({ method: 'GET', path, body: '' })),
    );
    for (const request of seen) {
      expect(request.headers['x-shared-context']).toBe(SENTINEL);
      expect(request.headers.authorization).toBe(REQUEST_HEADERS.Authorization);
      expect(request.headers.cookie).toBe(REQUEST_HEADERS.Cookie);
    }
    await until(() => {
      const path = ownedDatabase(home);
      if (!path) return false;
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }).n === 6;
      } finally {
        db.close();
      }
    }, 'six independently observed persisted samples');
    bridge.stdin!.write('stop\n');
    await until(() => nodeCode !== undefined && bridgeClosed, 'SIGINT exit and bridge reap');
    expect(nodeCode, 'Real CLI must complete normally after SIGINT').toBe(0);
    expect(bridgeCode).toBe(0);
    expect(bridgeDiagnostics).toBe('');
    plain();

    const dbPath = ownedDatabase(home);
    expect(dbPath).toBeDefined();
    const db = new Database(dbPath!, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare('SELECT consumer, status FROM sessions').all()).toEqual([
        { consumer: 'human', status: 'completed' },
      ]);
      const samples = db
        .prepare(
          'SELECT http_method, path, request_headers, response_headers FROM samples ORDER BY path',
        )
        .all() as Array<{
        http_method: string;
        path: string;
        request_headers: string | null;
        response_headers: string | null;
      }>;
      expect(samples).toHaveLength(6);
      expect(samples.map(({ http_method, path }) => ({ http_method, path }))).toEqual(
        [...PATHS].sort().map((path) => ({ http_method: 'GET', path })),
      );
      const aggregates = db
        .prepare(
          'SELECT snapshot, path, sample_count, request_headers, response_headers FROM aggregated_schemas ORDER BY path',
        )
        .all() as Array<{
        snapshot: number;
        path: string;
        sample_count: number;
        request_headers: string | null;
        response_headers: string | null;
      }>;
      expect(
        aggregates.map(({ snapshot, path, sample_count }) => ({ snapshot, path, sample_count })),
      ).toEqual([
        { snapshot: 1, path: '/catalog', sample_count: 3 },
        { snapshot: 1, path: '/items', sample_count: 3 },
      ]);
      for (const row of [...samples, ...aggregates]) {
        metadata(row.request_headers, ['x-shared-context', 'authorization', 'cookie']);
        metadata(row.response_headers, ['x-upstream-context', 'set-cookie']);
      }
    } finally {
      db.close();
    }
  } finally {
    // EOF is an explicit cleanup trigger. Python escalates only its own child,
    // reaps it, drains the terminal masters, and then exits. No process groups.
    if (bridge && !bridgeClosed) {
      bridge.stdin!.end();
      await new Promise<void>((done) => {
        if (bridgeClosed) return done();
        const timer = setTimeout(() => {
          // Emergency fallback is limited to the exact PID reported by this bridge.
          if (nodeCode === undefined && nodePid !== undefined) {
            try {
              process.kill(nodePid, 'SIGKILL');
            } catch {
              /* already reaped */
            }
          }
        }, 3_000);
        const hardTimer = setTimeout(() => {
          bridge!.kill('SIGKILL');
        }, 4_000);
        bridge!.once('close', () => {
          clearTimeout(timer);
          clearTimeout(hardTimer);
          done();
        });
      });
    }
    lines?.close();
    changed.clear();
    try {
      await close(reservation);
    } finally {
      try {
        await close(upstream);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
}, 45_000);
