import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('node:http');

import { BackendManager, type StatusBarAdapter } from '../BackendManager';

function makeStatusBar(): StatusBarAdapter & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    setText(t) { texts.push(t); },
    show() {},
    dispose() {},
  };
}

function makeHealthyHttpGet() {
  vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    cb(res);
    return Object.assign(new EventEmitter(), { destroy: vi.fn() }) as any;
  });
}

function makeFailingHttpGet() {
  vi.mocked(http.get).mockImplementation(() => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    return req as any;
  });
}

describe('BackendManager', () => {
  let statusBar: ReturnType<typeof makeStatusBar>;

  beforeEach(() => {
    statusBar = makeStatusBar();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits attached when backend is already running', async () => {
    makeHealthyHttpGet();

    const mgr = new BackendManager({ port: 5172, statusBar });
    const statuses: string[] = [];
    mgr.on('status', (s) => statuses.push(s));

    await mgr.connect();

    expect(mgr.isHealthy).toBe(true);
    expect(statuses).toEqual(['attached']);
  });

  it('polls until backend becomes healthy', async () => {
    let call = 0;
    vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      if (call++ < 2) {
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      } else {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        cb(res);
      }
      return req as any;
    });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 10 });
    const statuses: string[] = [];
    mgr.on('status', (s) => statuses.push(s));

    await mgr.connect();

    expect(mgr.isHealthy).toBe(true);
    expect(statuses).toEqual(['attached']);
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it('emits disconnected when backend never starts within timeout', async () => {
    makeFailingHttpGet();

    const statuses: string[] = [];
    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 10, pollTimeoutMs: 50 });
    mgr.on('status', (s) => statuses.push(s));

    await mgr.connect();

    expect(statuses).toContain('disconnected');
    expect(mgr.isHealthy).toBe(false);
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

/** http.get returns 200 iff `state.healthy`, else ECONNREFUSED. */
function makeToggleableHttpGet(state: { healthy: boolean }) {
  vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    if (state.healthy) {
      cb(Object.assign(new EventEmitter(), { statusCode: 200 }));
    } else {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    }
    return req as any;
  });
}

describe('BackendManager.start', () => {
  let statusBar: ReturnType<typeof makeStatusBar>;
  beforeEach(() => { statusBar = makeStatusBar(); vi.resetAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it('spawns the backend with --urls and attaches once healthy', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x/backend' });
    await mgr.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172']);
    expect(mgr.isHealthy).toBe(true);
  });

  it('attaches to an already-healthy backend without spawning', async () => {
    makeHealthyHttpGet();
    const spawn = vi.fn(() => makeChild());

    const mgr = new BackendManager({ port: 5172, statusBar, spawn, executablePath: '/x/backend' });
    await mgr.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(mgr.isHealthy).toBe(true);
  });

  // #205: the Output channel's level, translated by the caller into Serilog
  // spawn args, rides along on the same argv as --urls.
  it('appends the injected Serilog level args when spawning', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const mgr = new BackendManager({
      port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x/backend',
      serilogLevelArgs: () => ['--Serilog:MinimumLevel:Default', 'Debug'],
    });
    await mgr.start();

    expect(spawn).toHaveBeenCalledWith(
      '/x/backend',
      ['--urls', 'http://localhost:5172', '--Serilog:MinimumLevel:Default', 'Debug'],
    );
  });

  it('spawns with just --urls when serilogLevelArgs yields no override (e.g. channel at Off)', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const mgr = new BackendManager({
      port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x/backend',
      serilogLevelArgs: () => [],
    });
    await mgr.start();

    expect(spawn).toHaveBeenCalledWith('/x/backend', ['--urls', 'http://localhost:5172']);
  });
});

/** Backend output arrives asynchronously (readline); poll until `n` lines land. */
async function waitForLines(lines: string[], n: number) {
  for (let i = 0; i < 50 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 2));
}

/** A started manager whose spawned child's output is collected as `"<line> <source>"`. */
async function startWithOutput(statusBar: StatusBarAdapter) {
  const state = { healthy: false };
  makeToggleableHttpGet(state);
  const child = makeChild();
  const spawn = vi.fn(() => { state.healthy = true; return child; });
  const lines: string[] = [];

  const mgr = new BackendManager({
    port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x',
    onOutput: (line, source) => lines.push(`${line} ${source}`),
  });
  await mgr.start();
  return { mgr, child, lines };
}

describe('BackendManager output forwarding', () => {
  let statusBar: ReturnType<typeof makeStatusBar>;
  beforeEach(() => { statusBar = makeStatusBar(); vi.resetAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it('forwards whole lines, tagged with the stream they came from', async () => {
    const { child, lines } = await startWithOutput(statusBar);

    child.stdout.write('[08:30:45 INF] Indexed 500 records\n');
    child.stderr.write('Unhandled exception. boom\n');
    await waitForLines(lines, 2);

    expect(lines).toEqual([
      '[08:30:45 INF] Indexed 500 records stdout',
      'Unhandled exception. boom stderr',
    ]);
  });

  it('reassembles a line split across chunks and strips the CRLF a Windows backend writes', async () => {
    const { child, lines } = await startWithOutput(statusBar);

    child.stdout.write('[08:30:45 INF] Indexed ');
    child.stdout.write('500 records\r\n');
    await waitForLines(lines, 1);

    expect(lines).toEqual(['[08:30:45 INF] Indexed 500 records stdout']);
  });

  it('drains the streams even with no onOutput — an unread pipe would block the backend', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x' });
    await mgr.start();

    child.stdout.write('[08:30:45 INF] nobody is listening\n');
    await new Promise((r) => setTimeout(r, 5));

    expect(child.stdout.readableFlowing).toBe(true);
  });
});

describe('BackendManager crash-restart / stop', () => {
  let statusBar: ReturnType<typeof makeStatusBar>;
  beforeEach(() => { statusBar = makeStatusBar(); vi.resetAllMocks(); });
  afterEach(() => vi.restoreAllMocks());

  it('re-spawns and emits "restarted" when the backend exits unexpectedly', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); state.healthy = true; return c; });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x' });
    await mgr.start();

    const restarted = new Promise<void>((res) => mgr.on('restarted', () => res()));
    state.healthy = false;          // backend died
    children[0].emit('exit', 1);    // unexpected exit
    await restarted;

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(mgr.isHealthy).toBe(true);
  });

  it('does not double-spawn when start() is called concurrently', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const spawn = vi.fn(() => { state.healthy = true; return makeChild(); });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x' });
    await Promise.all([mgr.start(), mgr.start()]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mgr.isHealthy).toBe(true);
  });

  it('stop() during a pending start() cancels it — a late healthy response does not resurrect the session', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const spawn = vi.fn(() => makeChild()); // spawn does NOT make it healthy → connect keeps polling

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 5, pollTimeoutMs: 1000, spawn, executablePath: '/x' });
    const statuses: string[] = [];
    mgr.on('status', (s) => statuses.push(s));

    const startP = mgr.start();
    await new Promise((r) => setTimeout(r, 15)); // let it spawn + begin polling
    mgr.stop();
    state.healthy = true;                        // backend "comes up" after the user closed
    await startP;
    await new Promise((r) => setTimeout(r, 20)); // let any stray poll fire

    expect(mgr.isHealthy).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(statuses).not.toContain('attached');
  });

  it('caps crash-restarts instead of looping forever, then reports disconnected', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    // Every spawned child dies immediately and never becomes healthy.
    const spawn = vi.fn(() => { const c = makeChild(); process.nextTick(() => c.emit('exit', 1)); return c; });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 3, pollTimeoutMs: 10, spawn, executablePath: '/x' });
    const statuses: string[] = [];
    mgr.on('status', (s) => statuses.push(s));

    await mgr.start();
    await new Promise((r) => setTimeout(r, 150)); // let the restart chain settle

    expect(spawn.mock.calls.length).toBeLessThanOrEqual(5); // bounded, not infinite
    expect(statuses).toContain('disconnected');
  });

  it('forwards output from the restarted child, not just the first one', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const children: ReturnType<typeof makeChild>[] = [];
    const spawn = vi.fn(() => { const c = makeChild(); children.push(c); state.healthy = true; return c; });
    const lines: string[] = [];

    const mgr = new BackendManager({
      port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x',
      onOutput: (l) => lines.push(l),
    });
    await mgr.start();

    const restarted = new Promise<void>((res) => mgr.on('restarted', () => res()));
    state.healthy = false;
    children[0].emit('exit', 1);
    await restarted;

    children[1].stdout.write('[08:30:50 INF] back up\n');
    await waitForLines(lines, 1);

    expect(lines).toEqual(['[08:30:50 INF] back up']);
  });

  it('stop() kills the child and suppresses restart', async () => {
    const state = { healthy: false };
    makeToggleableHttpGet(state);
    const child = makeChild();
    const spawn = vi.fn(() => { state.healthy = true; return child; });

    const mgr = new BackendManager({ port: 5172, statusBar, pollIntervalMs: 5, spawn, executablePath: '/x' });
    await mgr.start();

    mgr.stop();
    expect(child.kill).toHaveBeenCalled();

    child.emit('exit', 0);          // deliberate stop → no respawn
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mgr.isHealthy).toBe(false);
  });
});
