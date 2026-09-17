import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BackendLifecycle } from '../backendLifecycle';
import type { BackendStatus } from '../MEditClient';
import { present } from '../../ports/present';

// `Server.address()` types as `string | AddressInfo | null` for the pipe/unbound cases neither
// test below hits, since both bind to 127.0.0.1 on an OS-assigned port.
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

// A crash-restart reaches attached again with no event of its own, so a test that waits for the
// fresh process waits for that second attach.
function nextAttach(lifecycle: BackendLifecycle): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = lifecycle.onStatusChanged((s) => { if (s === 'attached') { off(); resolve(); } });
  });
}

// `checkHealth` (backendLifecycle.ts's own injectable) answers from this shared flag, toggled
// by a test the same moment the real backend's own health would have flipped.
function healthCheck(state: { healthy: boolean }): () => Promise<boolean> {
  return () => Promise.resolve(state.healthy);
}

describe('BackendLifecycle', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('attaches when a backend is already running', async () => {
    const lifecycle = new BackendLifecycle({ port: 5172, checkHealth: () => Promise.resolve(true) });
    const statuses = record(lifecycle);

    await lifecycle.start();

    expect(lifecycle.status).toBe('attached');
    expect(statuses).toEqual(['attached']);
  });

  it('polls until backend becomes healthy', async () => {
    let call = 0;
    const checkHealth = vi.fn(() => Promise.resolve(call++ >= 2));

    const lifecycle = new BackendLifecycle({ port: 5172, pollIntervalMs: 10, checkHealth });
    const statuses = record(lifecycle);

    await lifecycle.start();

    expect(lifecycle.status).toBe('attached');
    expect(statuses).toEqual(['attached']);
    expect(checkHealth).toHaveBeenCalledTimes(3);
  });

  it('reports disconnected when backend never starts within timeout', async () => {
    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 10, pollTimeoutMs: 50, checkHealth: () => Promise.resolve(false),
    });
    const statuses = record(lifecycle);

    await lifecycle.start();

    expect(statuses).toContain('disconnected');
    expect(lifecycle.status).toBe('disconnected');
  });
});

// ── spawn / teardown / crash-restart ─────────────────────────────────────────

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
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x/backend', checkHealth: healthCheck(state),
    });
    await lifecycle.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172']);
    expect(lifecycle.status).toBe('attached');
  });

  it('attaches to an already-healthy backend without spawning', async () => {
    const spawn = vi.fn(() => makeChild());

    const lifecycle = new BackendLifecycle({
      port: 5172, spawn, executablePath: '/x/backend', checkHealth: () => Promise.resolve(true),
    });
    await lifecycle.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(lifecycle.status).toBe('attached');
  });

  // The Output channel's level, translated by the caller into Serilog
  // spawn args, rides along on the same argv as --urls.
  it('appends the injected Serilog level args when spawning', async () => {
    const state = { healthy: false };
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x/backend', checkHealth: healthCheck(state),
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
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x/backend', checkHealth: healthCheck(state),
      serilogLevelArgs: () => [],
    });
    await lifecycle.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172']);
  });
});

// Backend output arrives asynchronously through readline, so the count has to be polled.
async function waitForLines(lines: string[], n: number) {
  for (let i = 0; i < 50 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 2));
}

async function startWithOutput() {
  const state = { healthy: false };
  const child = makeChild();
  const spawn = vi.fn(() => { state.healthy = true; return child; });
  const lines: string[] = [];

  const lifecycle = new BackendLifecycle({
    port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
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
    await waitForLines(lines, 2);

    expect(lines).toEqual([
      '[08:30:45 INF] Indexed 500 records stdout',
      'Unhandled exception. boom stderr',
    ]);
  });

  it('reassembles a line split across chunks and strips the CRLF a Windows backend writes', async () => {
    const { child, lines } = await startWithOutput();

    child.stdout.write('[08:30:45 INF] Indexed ');
    child.stdout.write('500 records\r\n');
    await waitForLines(lines, 1);

    expect(lines).toEqual(['[08:30:45 INF] Indexed 500 records stdout']);
  });

  it('drains the streams even with no onOutput — an unread pipe would block the backend', async () => {
    const state = { healthy: false };
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await lifecycle.start();

    child.stdout.write('[08:30:45 INF] nobody is listening\n');
    await new Promise((r) => setTimeout(r, 5));

    expect(child.stdout.readableFlowing).toBe(true);
  });
});

describe('BackendLifecycle crash-restart / stop', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('re-spawns and reaches attached again when the backend exits unexpectedly', async () => {
    const state = { healthy: false };
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); state.healthy = true; return c; });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await lifecycle.start();

    const restarted = nextAttach(lifecycle);
    state.healthy = false;          // backend died
    present(children[0], 'the first spawned child').emit('exit', 1);    // unexpected exit
    await restarted;

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(lifecycle.status).toBe('attached');
  });

  // The crash is the news the views act on: the reconcile is abandoned and the status bar says
  // so, rather than the tree silently holding a load order no process is behind.
  it('reports disconnected the moment the backend dies, before the restart is attempted', async () => {
    const state = { healthy: false };
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); state.healthy = true; return c; });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await lifecycle.start();
    const statuses = record(lifecycle);

    const restarted = nextAttach(lifecycle);
    state.healthy = false;
    present(children[0], 'the first spawned child').emit('exit', 1);
    await restarted;

    expect(statuses).toEqual(['disconnected', 'starting', 'attached']);
  });

  it('does not double-spawn when start() is called concurrently', async () => {
    const state = { healthy: false };
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await Promise.all([lifecycle.start(), lifecycle.start()]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lifecycle.status).toBe('attached');
  });

  it('stop() during an in-flight start() cancels it — a late healthy response does not resurrect the load order', async () => {
    const state = { healthy: false };
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); return c; }); // spawn does NOT make it healthy → connect keeps polling

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, pollTimeoutMs: 1000, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    const statuses = record(lifecycle);

    const startP = lifecycle.start();
    await new Promise((r) => setTimeout(r, 15)); // let it spawn + begin polling
    const stopP = lifecycle.stop();
    present(children[0], 'the first spawned child').emit('exit', 0);                 // confirm the kill so stop() settles without waiting out the real grace period
    state.healthy = true;                        // backend "comes up" after the user closed
    await Promise.all([startP, stopP]);
    await new Promise((r) => setTimeout(r, 20)); // let any stray poll fire

    expect(lifecycle.status).toBe('stopped');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(statuses).not.toContain('attached');
  });

  it('caps crash-restarts instead of looping forever, then reports disconnected', async () => {
    const state = { healthy: false };
    // Every spawned child dies immediately and never becomes healthy.
    const spawn = vi.fn(() => { const c = makeChild(); process.nextTick(() => c.emit('exit', 1)); return c; });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 3, pollTimeoutMs: 10, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    const statuses = record(lifecycle);

    await lifecycle.start();
    await new Promise((r) => setTimeout(r, 150)); // let the restart chain settle

    expect(spawn.mock.calls.length).toBeLessThanOrEqual(5); // bounded, not infinite
    expect(statuses).toContain('disconnected');
    expect(lifecycle.status).toBe('disconnected');
  });

  it('forwards output from the restarted child, not just the first one', async () => {
    const state = { healthy: false };
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); state.healthy = true; return c; });
    const lines: string[] = [];

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
      onOutput: (l) => lines.push(l),
    });
    await lifecycle.start();

    const restarted = nextAttach(lifecycle);
    state.healthy = false;
    present(children[0], 'the first spawned child').emit('exit', 1);
    await restarted;

    present(children[1], 'the second (restarted) child').stdout.write('[08:30:50 INF] back up\n');
    await waitForLines(lines, 1);

    expect(lines).toEqual(['[08:30:50 INF] back up']);
  });

  // deactivate() awaits this, so a reload cannot build a replacement client — which would hold no
  // reference to this child — before the old child is gone.
  it('stop() kills the child, suppresses restart, and does not report "stopped" until exit is confirmed', async () => {
    const state = { healthy: false };
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', checkHealth: healthCheck(state),
    });
    await lifecycle.start();
    const statuses = record(lifecycle);

    const stopped = lifecycle.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(statuses).not.toContain('stopped');

    child.emit('exit', 0);          // deliberate stop → no respawn
    await stopped;

    expect(statuses).toEqual(['stopped']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lifecycle.status).toBe('stopped');
  });

  it('escalates to SIGKILL if the child never exits within the grace period, then confirms exit', async () => {
    vi.useFakeTimers();
    const state = { healthy: false };
    const child = makeChild(); // never emits 'exit' on its own — models a hung, non-yielding backend
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const lifecycle = new BackendLifecycle({
      port: 5172, pollIntervalMs: 5, spawn, executablePath: '/x', stopGracePeriodMs: 3000, checkHealth: healthCheck(state),
    });
    await lifecycle.start();
    const statuses = record(lifecycle);

    const stopped = lifecycle.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(3000); // grace period elapses with no exit
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    // Still withheld: exit has not been observed even after SIGKILL is sent.
    expect(statuses).not.toContain('stopped');

    child.emit('exit', null); // the OS finally reaps it
    await stopped;

    expect(statuses).toEqual(['stopped']);
  });
});

// Every other suite in this file injects `checkHealth`, so the real default adapter —
// `checkHealthOverHttp`'s GET `/health` — needs its own coverage, over a real local server.
describe('BackendLifecycle (no checkHealth injected — the real GET /health adapter)', () => {
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

    const lifecycle = new BackendLifecycle({ port });
    await lifecycle.start();

    expect(lifecycle.status).toBe('attached');
  });

  // The rival: inverting the status check (`!== 200`) would report attached for a refused
  // connection and disconnected for a real 200 — this and the test above catch either flip.
  it('reports disconnected when the connection is refused', async () => {
    // Listens just long enough to claim a free port, then closes it — nothing answers next.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const claimed = addressInfo(probe.address()).port;
        probe.close(() => resolve(claimed));
      });
    });

    const lifecycle = new BackendLifecycle({ port, pollIntervalMs: 5, pollTimeoutMs: 30 });
    await lifecycle.start();

    expect(lifecycle.status).toBe('disconnected');
  });
});
