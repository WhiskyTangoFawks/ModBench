import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { BackendLifecycle } from '../backendLifecycle';
import type { BackendStatus } from '../MEditClient';
import { present } from '../../ports/present';

function addressInfo(address: ReturnType<Server['address']>): AddressInfo {
  if (address === null || typeof address === 'string') {
    throw new Error(`expected an AddressInfo, got ${String(address)}`);
  }
  return address;
}

function record(lifecycle: BackendLifecycle): BackendStatus[] {
  const statuses: BackendStatus[] = [];
  lifecycle.onStatusChanged((s) => statuses.push(s));
  return statuses;
}

function healthCheck(state: { healthy: boolean }): () => Promise<boolean> {
  return () => Promise.resolve(state.healthy);
}

describe('BackendLifecycle', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('attaches when a backend is already running', async () => {
    const lifecycle = new BackendLifecycle({ attachPort: 5172, checkHealth: () => Promise.resolve(true) });
    const statuses = record(lifecycle);

    await lifecycle.start();

    expect(lifecycle.status).toBe('running');
    expect(statuses).toEqual(['running']);
  });

  it('polls until backend becomes healthy', async () => {
    let call = 0;
    const checkHealth = vi.fn(() => Promise.resolve(call++ >= 2));

    const lifecycle = new BackendLifecycle({ attachPort: 5172, pollIntervalMs: 10, checkHealth });
    const statuses = record(lifecycle);

    await lifecycle.start();

    expect(lifecycle.status).toBe('running');
    expect(statuses).toEqual(['running']);
    expect(checkHealth).toHaveBeenCalledTimes(3);
  });

  it('reports disconnected when backend never starts within timeout', async () => {
    const lifecycle = new BackendLifecycle({
      attachPort: 5172, pollIntervalMs: 10, pollTimeoutMs: 50, checkHealth: () => Promise.resolve(false),
    });
    const statuses = record(lifecycle);

    await lifecycle.start();

    expect(statuses).toContain('disconnected');
    expect(lifecycle.status).toBe('disconnected');
  });
});

function makeChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

describe('BackendLifecycle.start', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it('spawns the backend with --urls and attaches once healthy', async () => {
    const state = { healthy: false };
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x/backend', checkHealth: healthCheck(state),
    });
    await lifecycle.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172']);
    expect(lifecycle.status).toBe('running');
  });

  it('spawns its own backend even when something already answers health, not adopting whatever answers on a shared port such as another window\'s backend', async () => {
    const spawn = vi.fn(() => makeChild());

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(41000), spawn, executablePath: '/x/backend', checkHealth: () => Promise.resolve(true),
    });
    await lifecycle.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:41000']);
  });

  it('is not running when its child exits at once while another backend answers its port, polling /health alone reporting Running on whichever backend took the port in the gap', async () => {
    const spawn = vi.fn(() => {
      const child = makeChild();
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x',
      checkHealth: () => Promise.resolve(true),
    });
    const statuses = record(lifecycle);
    await lifecycle.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(statuses).not.toContain('running');
  });

  it('gives each lifecycle its own free port', async () => {
    const ports = await Promise.all([1, 2].map(async () => {
      const lifecycle = new BackendLifecycle({
        spawn: () => makeChild(), executablePath: '/x', checkHealth: () => Promise.resolve(true),
      });
      await lifecycle.start();
      return lifecycle.port;
    }));

    expect(ports[0]).toBeGreaterThan(0);
    expect(ports[0]).not.toBe(ports[1]);
  });

  it('attaches to the developer port and never spawns, even when nothing answers, attach not being a fallback that spawns when the port does not answer', async () => {
    const spawn = vi.fn(() => makeChild());

    const lifecycle = new BackendLifecycle({
      attachPort: 5172, pollIntervalMs: 5, pollTimeoutMs: 20, spawn, executablePath: '/x/backend',
      checkHealth: () => Promise.resolve(false),
    });
    await lifecycle.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(lifecycle.port).toBe(5172);
    expect(lifecycle.status).toBe('disconnected');
  });

  it('attaches to the developer port once it answers', async () => {
    const lifecycle = new BackendLifecycle({ attachPort: 5172, checkHealth: () => Promise.resolve(true) });
    await lifecycle.start();

    expect(lifecycle.status).toBe('running');
  });

  it('appends the injected Serilog level args when spawning, on the same argv as --urls', async () => {
    const state = { healthy: false };
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x/backend', checkHealth: healthCheck(state),
      serilogLevelArgs: () => ['--Serilog:MinimumLevel:Default', 'Debug'],
    });
    await lifecycle.start();

    expect(spawn).toHaveBeenCalledWith(
      '/x/backend',
      ['--urls', 'http://localhost:5172', '--Serilog:MinimumLevel:Default', 'Debug'],
    );
  });

  it('spawns with just --urls when serilogLevelArgs yields no override (e.g. channel at Off)', async () => {
    const state = { healthy: false };
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x/backend', checkHealth: healthCheck(state),
      serilogLevelArgs: () => [],
    });
    await lifecycle.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172']);
  });
});

async function pollForLines(lines: string[], n: number) {
  for (let i = 0; i < 50 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 2));
}

async function startWithOutput() {
  const state = { healthy: false };
  const child = makeChild();
  const spawn = vi.fn(() => { state.healthy = true; return child; });
  const lines: string[] = [];

  const lifecycle = new BackendLifecycle({
    freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    onOutput: (line, source) => lines.push(`${line} ${source}`),
  });
  await lifecycle.start();
  return { lifecycle, child, lines };
}

describe('BackendLifecycle output forwarding', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it('forwards whole lines, tagged with the stream they came from', async () => {
    const { child, lines } = await startWithOutput();

    child.stdout.write('[08:30:45 INF] Indexed 500 records\n');
    child.stderr.write('Unhandled exception. boom\n');
    await pollForLines(lines, 2);

    expect(lines).toEqual([
      '[08:30:45 INF] Indexed 500 records stdout',
      'Unhandled exception. boom stderr',
    ]);
  });

  it('reassembles a line split across chunks and strips the CRLF a Windows backend writes', async () => {
    const { child, lines } = await startWithOutput();

    child.stdout.write('[08:30:45 INF] Indexed ');
    child.stdout.write('500 records\r\n');
    await pollForLines(lines, 1);

    expect(lines).toEqual(['[08:30:45 INF] Indexed 500 records stdout']);
  });

  it('drains the streams even with no onOutput — an unread pipe would block the backend', async () => {
    const state = { healthy: false };
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await lifecycle.start();

    child.stdout.write('[08:30:45 INF] nobody is listening\n');

    const flowingSynchronouslyAsReadlineResumesItOnConstruction = child.stdout.readableFlowing;
    expect(flowingSynchronouslyAsReadlineResumesItOnConstruction).toBe(true);
  });
});

describe('BackendLifecycle exit / stop', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('stays stopped when the backend exits after running, logging why and starting nothing', async () => {
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const logged: string[] = [];
    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x',
      checkHealth: () => Promise.resolve(true), log: (line) => logged.push(line),
    });
    await lifecycle.start();
    const statuses = record(lifecycle);

    present(children[0], 'the first spawned child').emit('exit', 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(statuses).toEqual(['stopped']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(logged).toContain('[backend] mEdit exited unexpectedly (code 1)');
  });

  it('stays stopped when the child exits before it answers, and the start settles', async () => {
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 3, spawn, executablePath: '/x', checkHealth: () => Promise.resolve(false),
    });
    const started = lifecycle.start();
    await vi.waitFor(() => expect(children).toHaveLength(1), { interval: 2 });

    present(children[0], 'the first spawned child').emit('exit', 1);
    await started;

    expect(lifecycle.status).toBe('stopped');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('logs the signal that ended the backend when it has no exit code', async () => {
    const children: ReturnType<typeof makeChild>[] = [];
    const logged: string[] = [];
    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, executablePath: '/x', checkHealth: () => Promise.resolve(true),
      spawn: () => { const c = makeChild(); children.push(c); return c; }, log: (line) => logged.push(line),
    });
    await lifecycle.start();

    present(children[0], 'the first spawned child').emit('exit', null, 'SIGSEGV');

    expect(logged).toContain('[backend] mEdit exited unexpectedly (signal SIGSEGV)');
  });

  it('is stopped, logging why, when the backend cannot be spawned at all', async () => {
    const logged: string[] = [];
    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, pollTimeoutMs: 10_000, executablePath: '/nonexistent/backend',
      checkHealth: () => Promise.resolve(false), log: (line) => logged.push(line),
      spawn: (exe, args) => nodeSpawn(exe, args, { stdio: 'pipe' }),
    });

    await lifecycle.start();

    expect(lifecycle.status).toBe('stopped');
    expect(logged.some((line) => line.startsWith('[backend] mEdit failed to start: spawn /nonexistent/backend ENOENT'))).toBe(true);
  });

  it.each([
    ['claiming a port throws', { freePort: () => Promise.reject(new Error('no port')) }],
    ['the spawn throws', { freePort: () => Promise.resolve(5172), spawn: () => { throw new Error('no spawn'); } }],
  ])('is stopped by the stop after a start that threw, %s', async (_name, options) => {
    const lifecycle = new BackendLifecycle({ executablePath: '/x', checkHealth: () => Promise.resolve(true), ...options });
    await lifecycle.start().catch(() => undefined);

    await lifecycle.stop();

    expect(lifecycle.status).toBe('stopped');
  });

  it('is stopped by the stop after an attach that timed out, so the item agrees with the failed launch', async () => {
    const lifecycle = new BackendLifecycle({
      attachPort: 5172, pollIntervalMs: 5, pollTimeoutMs: 20, checkHealth: () => Promise.resolve(false),
    });
    await lifecycle.start();
    expect(lifecycle.status).toBe('disconnected');

    await lifecycle.stop();

    expect(lifecycle.status).toBe('stopped');
  });

  it('does not double-spawn when start() is called concurrently', async () => {
    const state = { healthy: false };
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await Promise.all([lifecycle.start(), lifecycle.start()]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lifecycle.status).toBe('running');
  });

  it('stop() during an in-flight start() cancels it — a late healthy response does not resurrect the load order, the generation stop() bumped being checked by every already-scheduled poll', async () => {
    vi.useFakeTimers();
    const state = { healthy: false };
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); return c; });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, pollTimeoutMs: 1000, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    const statuses = record(lifecycle);

    const startP = lifecycle.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopP = lifecycle.stop();
    present(children[0], 'the first spawned child').emit('exit', 0);
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([startP, stopP]);
    await vi.advanceTimersByTimeAsync(50);

    expect(lifecycle.status).toBe('stopped');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(statuses).not.toContain('running');
  });

  it('spawns nothing after a stop that follows a child exiting during a start', async () => {
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 3, spawn, executablePath: '/x', checkHealth: () => Promise.resolve(false),
    });
    const started = lifecycle.start();
    await vi.waitFor(() => expect(children).toHaveLength(1), { interval: 2 });

    present(children[0], 'the first spawned child').emit('exit', 1);
    await lifecycle.stop();
    await started;

    expect(children).toHaveLength(1);
  });

  it('stop() kills the child, and does not report "stopped" until exit is confirmed, so deactivate() awaiting it keeps a reload from building a replacement client before the old child is gone', async () => {
    const state = { healthy: false };
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await lifecycle.start();
    const statuses = record(lifecycle);

    const stopped = lifecycle.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(statuses).not.toContain('stopped');

    child.emit('exit', 0);
    await stopped;

    expect(statuses).toEqual(['stopped']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lifecycle.status).toBe('stopped');
  });

  it('escalates to SIGKILL if the child never exits within the grace period, withholding stopped until exit is observed even after SIGKILL is sent', async () => {
    vi.useFakeTimers();
    const state = { healthy: false };
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const lifecycle = new BackendLifecycle({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 5, spawn, executablePath: '/x', stopGracePeriodMs: 3000, checkHealth: healthCheck(state),
    });
    await lifecycle.start();
    const statuses = record(lifecycle);

    const stopped = lifecycle.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(statuses).not.toContain('stopped');

    child.emit('exit', null);
    await stopped;

    expect(statuses).toEqual(['stopped']);
  });
});

describe('BackendLifecycle with no health check injected, asking a real local server over GET /health as every other suite injects its check', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const s = server;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    server = undefined;
  });

  it('attaches when a real GET /health answers 200', async () => {
    const s = createServer((_req, res) => { res.writeHead(200); res.end(); });
    server = s;
    const port = await new Promise<number>((resolve) => {
      s.listen(0, '127.0.0.1', () => resolve(addressInfo(s.address()).port));
    });

    const lifecycle = new BackendLifecycle({ attachPort: port });
    await lifecycle.start();

    expect(lifecycle.status).toBe('running');
  });

  it('reports disconnected when the connection is refused, the status check not inverted (`!== 200`), which would report attached for a refused connection', async () => {
    const portNothingAnswersOn = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const claimed = addressInfo(probe.address()).port;
        probe.close(() => resolve(claimed));
      });
    });

    const lifecycle = new BackendLifecycle({ attachPort: portNothingAnswersOn, pollIntervalMs: 5, pollTimeoutMs: 30 });
    await lifecycle.start();

    expect(lifecycle.status).toBe('disconnected');
  });
});
