import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';

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
  vi.mocked(http.get).mockImplementation((_url: any, _cb: any) => {
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
