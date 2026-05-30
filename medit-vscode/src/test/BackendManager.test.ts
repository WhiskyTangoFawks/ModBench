import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

vi.mock('node:http');
vi.mock('node:child_process');

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
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    return req as any;
  });
}

function makeFailingHttpGet() {
  vi.mocked(http.get).mockImplementation((_url: any, _cb: any) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    // emit error asynchronously so the manager has a chance to register listener
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

  it('enters attached mode when health check succeeds immediately', async () => {
    makeHealthyHttpGet();

    const mgr = new BackendManager({ port: 5172, statusBar });
    await mgr.connect();

    expect(mgr.mode).toBe('attached');
    expect(mgr.isHealthy).toBe(true);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('enters managed mode and spawns process when health check fails', async () => {
    // First call fails (no existing backend), then succeeds after spawn
    let call = 0;
    vi.mocked(http.get).mockImplementation((_url: any, cb: any) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      if (call === 0) {
        call++;
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      } else {
        call++;
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        cb(res);
      }
      return req as any;
    });

    const fakeProcess = Object.assign(new EventEmitter(), {
      pid: 999,
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(fakeProcess as any);

    const mgr = new BackendManager({ port: 5172, statusBar, binaryPath: '/fake/backend', pollIntervalMs: 10 });
    await mgr.connect();

    expect(mgr.mode).toBe('managed');
    expect(childProcess.spawn).toHaveBeenCalledWith('/fake/backend', expect.any(Array), expect.any(Object));
    expect(mgr.isHealthy).toBe(true);
  });

  it('emits disconnected status when poll times out', async () => {
    makeFailingHttpGet();

    const fakeProcess = Object.assign(new EventEmitter(), {
      pid: 999, kill: vi.fn(),
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(fakeProcess as any);

    const statuses: string[] = [];
    const mgr = new BackendManager({ port: 5172, statusBar, binaryPath: '/fake/backend', pollIntervalMs: 10, pollTimeoutMs: 50 });
    mgr.on('status', (s) => statuses.push(s));

    await mgr.connect().catch(() => {});

    expect(statuses).toContain('disconnected');
    expect(mgr.isHealthy).toBe(false);
  });
});
