import { describe, it, expect, vi, afterEach } from 'vitest';
import { leveledLog, type LeveledLog } from '../../test/leveledLog';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { createMEditClient, type MEditClient } from '..';
import { answered } from './healthAnswer';
import { IGNORED_THROWS } from './fixtures';
import { settled } from '../../test/eventually';
import { backendProcesses, fakeLogChannel, neverFetch, spawnedBackend } from './fakeMEdit';

type Backend = NonNullable<Parameters<typeof createMEditClient>[0]['backend']>;
type HealthAnswer = Awaited<ReturnType<NonNullable<Backend['checkHealth']>>>;

function addressInfo(address: ReturnType<Server['address']>): AddressInfo {
  if (address === null || typeof address === 'string') {
    throw new Error(`expected an AddressInfo, got ${String(address)}`);
  }
  return address;
}

const clientOver = (backend: Backend, log?: LeveledLog): MEditClient =>
  createMEditClient({ listenerThrows: IGNORED_THROWS, backendLog: fakeLogChannel(0), fetch: neverFetch(), log, backend });

/** A client over a backend it spawns, as `spawnedBackend` makes it unless `overrides` say otherwise. */
function spawning(overrides: Partial<Backend> = {}, { log, ignoresStdinClose = false }: { log?: LeveledLog; ignoresStdinClose?: boolean } = {}) {
  const { backend, spawned } = spawnedBackend(overrides, backendProcesses({ ignoresStdinClose }));
  return { client: clientOver(backend, log), spawned };
}

function record(client: MEditClient): string[] {
  const statuses: string[] = [];
  client.onStatusChanged((s) => statuses.push(s));
  return statuses;
}

function portsHeard(client: MEditClient): number[] {
  const heard: number[] = [];
  client.onPort((port) => heard.push(port));
  return heard;
}

describe('BackendLifecycle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('attaches when a backend is already running', async () => {
    const client = clientOver({ attachPort: 5172, checkHealth: () => Promise.resolve(answered(true)) });
    const statuses = record(client);

    await client.start();

    expect(client.status).toBe('running');
    expect(statuses).toEqual(['running']);
  });

  it('polls until backend becomes healthy', async () => {
    let call = 0;
    const checkHealth = vi.fn(() => Promise.resolve(answered(call++ >= 2)));
    const client = clientOver({ attachPort: 5172, pollIntervalMs: 0, checkHealth });
    const statuses = record(client);

    await client.start();

    expect(client.status).toBe('running');
    expect(statuses).toEqual(['running']);
    expect(checkHealth).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['answers unhealthy', () => Promise.resolve(answered(false))],
    ['never settles', () => new Promise<HealthAnswer>(() => {})],
  ])('reports disconnected at the deadline when the health check %s', async (_case, checkHealth) => {
    const client = clientOver({ attachPort: 5172, pollIntervalMs: 10, pollTimeoutMs: 0, checkHealth });
    const statuses = record(client);

    await client.start();

    expect(statuses).toEqual(['disconnected', 'stopped']);
  });

  describe('why nothing answered', () => {
    const refused: HealthAnswer = { healthy: false, reason: 'refused' };
    const hangs = () => new Promise<HealthAnswer>(() => {});
    const useFakeTimers = () => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); };

    it('says the backend did not answer in time when the deadline cuts off a request that hangs, and destroys the request', async () => {
      useFakeTimers();
      const silent = createServer(() => {});
      const connected = new Promise<Socket>((resolve) => silent.on('connection', resolve));
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const logged = leveledLog();
      const client = clientOver({ attachPort: addressInfo(silent.address()).port, pollIntervalMs: 1000, pollTimeoutMs: 1000 }, logged);

      const started = client.start();
      const socket = await connected;
      const closed = new Promise((resolve) => socket.on('close', resolve));
      await vi.advanceTimersByTimeAsync(1000);
      await started;
      await closed;
      silent.close();

      expect(logged.lines.error).toEqual([expect.stringMatching(/Timed out waiting for backend on port \d+: it did not answer in time/)]);
    });

    it('is disconnected when a refused connection does not answer, logging why once, at the deadline, and not on each poll before it', async () => {
      useFakeTimers();
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const { port } = addressInfo(closed.address());
      await new Promise((resolve) => closed.close(resolve));
      const logged = leveledLog();
      const client = clientOver({ attachPort: port, pollIntervalMs: 1000, pollTimeoutMs: 1000 }, logged);
      const statuses = record(client);

      await client.start();

      expect(statuses).toContain('disconnected');
      expect(logged.lines.warn).toEqual([]);
      expect(logged.lines.error).toEqual([expect.stringMatching(/Timed out waiting for backend on port \d+: .*ECONNREFUSED/)]);
    });

    it('reports the attempt the deadline cut off, not the reason of an earlier one', async () => {
      useFakeTimers();
      const checkHealth = vi.fn().mockResolvedValueOnce(refused).mockImplementation(hangs);
      const logged = leveledLog();

      const started = clientOver({ attachPort: 5172, pollIntervalMs: 5, pollTimeoutMs: 40, checkHealth }, logged).start();
      await vi.advanceTimersByTimeAsync(40);
      await started;

      expect(logged.lines.error).toEqual([expect.stringContaining('it did not answer in time')]);
    });

    it('reports no reason from an earlier start of the same lifecycle', async () => {
      useFakeTimers();
      let check: () => Promise<HealthAnswer> = () => Promise.resolve(refused);
      const logged = leveledLog();
      const client = clientOver({ attachPort: 5172, pollIntervalMs: 5, pollTimeoutMs: 40, checkHealth: () => check() }, logged);

      const first = client.start();
      await vi.advanceTimersByTimeAsync(40);
      await first;
      check = hangs;
      const second = client.start();
      await vi.advanceTimersByTimeAsync(40);
      await second;

      expect(logged.lines.error).toEqual([expect.stringContaining('refused'), expect.stringContaining('it did not answer in time')]);
    });
  });
});

describe('BackendLifecycle.start', () => {
  it('spawns its own backend even when something already answers health, not adopting whatever answers on a shared port such as another window\'s backend', async () => {
    const { client, spawned } = spawning({ freePort: () => Promise.resolve(41000) });

    await client.start();

    expect(spawned.map(({ executable, args }) => [executable, args])).toEqual([['/x/backend', ['--urls', 'http://localhost:41000']]]);
  });

  it('is not running when its child exits at once while another backend answers its port, polling /health alone reporting Running on whichever backend took the port in the gap', async () => {
    const processes = backendProcesses();
    const { backend } = spawnedBackend({
      spawn: (executable, args) => {
        const child = processes.spawn(executable, args);
        queueMicrotask(() => { child.exit(1); });
        return child;
      },
    });
    const client = clientOver(backend);
    const statuses = record(client);

    await client.start();

    expect(statuses).not.toContain('running');
  });

  it('gives each lifecycle its own free port', async () => {
    const ports = await Promise.all([1, 2].map(async () => {
      const { client } = spawning({ freePort: undefined });
      const heard = portsHeard(client);
      await client.start();
      return heard;
    }));

    expect(ports[0]?.[0]).toBeGreaterThan(0);
    expect(ports[0]).not.toEqual(ports[1]);
  });

  it('attaches to the developer port and never spawns, even when nothing answers, attach not being a fallback that spawns when the port does not answer', async () => {
    const { client, spawned } = spawning({ attachPort: 5172, pollTimeoutMs: 0, checkHealth: () => Promise.resolve(answered(false)) });
    const ports = portsHeard(client);

    await client.start();

    expect(spawned).toEqual([]);
    expect(ports).toEqual([5172]);
  });

  it('spawns its own backend when the setting declares no attach port, which VS Code reads as null', async () => {
    const { client, spawned } = spawning({ attachPort: null });

    await client.start();

    expect(spawned).toHaveLength(1);
  });

  it('tells a port listener the attached port as it subscribes', () => {
    const client = clientOver({ attachPort: 5172 });

    expect(portsHeard(client)).toEqual([5172]);
  });

  it('tells a port listener the spawned backend\'s port once claimed, before the backend answers', async () => {
    const { client } = spawning({ freePort: () => Promise.resolve(41000), pollTimeoutMs: 0, checkHealth: () => Promise.resolve(answered(false)) });
    const heard = portsHeard(client);
    expect(heard).toEqual([]);

    await client.start();

    expect(heard).toEqual([41000]);
  });

  it('tells no port listener once it has unsubscribed', async () => {
    const { client } = spawning({ freePort: () => Promise.resolve(41000), pollTimeoutMs: 0, checkHealth: () => Promise.resolve(answered(false)) });
    const heard: number[] = [];
    client.onPort((port) => heard.push(port))();

    await client.start();

    expect(heard).toEqual([]);
  });
});

describe('BackendLifecycle output forwarding', () => {
  it('reassembles a line split across chunks and strips the CRLF a Windows backend writes', async () => {
    const channel = fakeLogChannel();
    const { backend, spawned } = spawnedBackend();
    const client = createMEditClient({ listenerThrows: IGNORED_THROWS, backendLog: channel, fetch: neverFetch(), backend });
    await client.start();

    spawned[0]?.stdout.write('[08:30:45 INF] Indexed ');
    spawned[0]?.stdout.write('500 records\r\n');

    await settled(() => { expect(channel.info.mock.calls).toEqual([['[backend] Indexed 500 records']]); });
  });

  it('drains the backend\'s streams, as an unread pipe would block the backend', async () => {
    const { client, spawned } = spawning();

    await client.start();

    expect([spawned[0]?.stdout.readableFlowing, spawned[0]?.stderr.readableFlowing]).toEqual([true, true]);
  });
});

describe('BackendLifecycle exit / stop', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('stays stopped when the backend exits after running, logging why and starting nothing', async () => {
    const logged = leveledLog();
    const { client, spawned } = spawning({}, { log: logged });
    await client.start();
    const statuses = record(client);

    spawned[0]?.exit(1);
    await settled(() => { expect(statuses).toEqual(['stopped']); });

    expect(spawned).toHaveLength(1);
    expect(logged.lines.error).toContain('[backend] mEdit exited unexpectedly (code 1)');
  });

  it('stays stopped when the child exits before it answers, and the start settles', async () => {
    const { client, spawned } = spawning({ pollIntervalMs: 0, checkHealth: () => Promise.resolve(answered(false)) });
    const started = client.start();
    await settled(() => { expect(spawned).toHaveLength(1); });

    spawned[0]?.exit(1);
    await started;

    expect(client.status).toBe('stopped');
    expect(spawned).toHaveLength(1);
  });

  it('logs the signal that ended the backend when it has no exit code', async () => {
    const logged = leveledLog();
    const { client, spawned } = spawning({}, { log: logged });
    await client.start();

    spawned[0]?.exit(null, 'SIGSEGV');

    expect(logged.lines.error).toContain('[backend] mEdit exited unexpectedly (signal SIGSEGV)');
  });

  it('is stopped, logging why, when the backend cannot be spawned at all', async () => {
    const logged = leveledLog();
    const client = clientOver({
      freePort: () => Promise.resolve(5172), pollIntervalMs: 0, executablePath: '/nonexistent/backend', checkHealth: () => Promise.resolve(answered(false)),
    }, logged);

    await client.start();

    expect(client.status).toBe('stopped');
    expect(logged.lines.error.some((line) => line.startsWith('[backend] mEdit failed to start: spawn /nonexistent/backend ENOENT'))).toBe(true);
  });

  it.each([
    ['claiming a port throws', { freePort: () => Promise.reject(new Error('no port')) }],
    ['the spawn throws', { spawn: () => { throw new Error('no spawn'); } }],
  ])('is stopped by the stop after a start that threw, %s', async (_name, options) => {
    const { client } = spawning(options);

    await client.start();

    expect(client.status).toBe('stopped');
  });

  it('does not double-spawn when start() is called concurrently', async () => {
    const { client, spawned } = spawning();

    await Promise.all([client.start(), client.start()]);

    expect(spawned).toHaveLength(1);
    expect(client.status).toBe('running');
  });

  it('stop() during an in-flight start() cancels it — a late healthy response does not resurrect the load order, the generation stop() bumped being checked by every already-scheduled poll', async () => {
    vi.useFakeTimers();
    const state = { healthy: false };
    const { client, spawned } = spawning({ pollIntervalMs: 5, pollTimeoutMs: 1000, checkHealth: () => Promise.resolve(answered(state.healthy)) });
    const statuses = record(client);

    const started = client.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = client.stop();
    spawned[0]?.exit(0);
    state.healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([started, stopped]);
    await vi.advanceTimersByTimeAsync(50);

    expect(client.status).toBe('stopped');
    expect(spawned).toHaveLength(1);
    expect(statuses).not.toContain('running');
  });

  it('spawns nothing after a stop that follows a child exiting during a start', async () => {
    const { client, spawned } = spawning({ pollIntervalMs: 0, checkHealth: () => Promise.resolve(answered(false)) });
    const started = client.start();
    await settled(() => { expect(spawned).toHaveLength(1); });

    spawned[0]?.exit(1);
    await client.stop();
    await started;

    expect(spawned).toHaveLength(1);
  });

  it('stop() closes the child\'s stdin, and does not report "stopped" until exit is confirmed, so deactivate() awaiting it keeps a reload from building a replacement client before the old child is gone', async () => {
    const { client, spawned } = spawning({}, { ignoresStdinClose: true });
    await client.start();
    const statuses = record(client);

    const stopped = client.stop();
    await settled(() => { expect(spawned[0]?.stdin.writableEnded).toBe(true); });
    expect(spawned[0]?.killed).toEqual([]);
    expect(statuses).not.toContain('stopped');

    spawned[0]?.exit(0);
    await stopped;

    expect(statuses).toEqual(['stopped']);
    expect(spawned).toHaveLength(1);
    expect(client.status).toBe('stopped');
  });

  it('escalates to SIGKILL if the child never exits within the grace period, withholding stopped until exit is observed even after SIGKILL is sent', async () => {
    vi.useFakeTimers();
    const { client, spawned } = spawning({ stopGracePeriodMs: 3000 }, { ignoresStdinClose: true });
    await client.start();
    const statuses = record(client);

    const stopped = client.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned[0]?.stdin.writableEnded).toBe(true);
    expect(spawned[0]?.killed).toEqual([]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(spawned[0]?.killed).toEqual(['SIGKILL']);
    expect(statuses).not.toContain('stopped');

    spawned[0]?.exit(null);
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
    const client = clientOver({ attachPort: port });

    await client.start();

    expect(client.status).toBe('running');
  });
});
