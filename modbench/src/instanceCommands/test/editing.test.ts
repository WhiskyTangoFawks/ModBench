import { describe, it, expect, vi } from 'vitest';
import {
  createLoadOrderSender, InMemoryMEditClient, type LoadOrderOutcome, type LoadOrderPluginInput, type LoadOrderProgress,
} from '../../client';
import { editingFlow } from '../editing';
import type { LoadOrderSource } from '../loadOrder';

const STATUS: LoadOrderProgress = {
  totalPlugins: 1, activePlugins: 1, version: 7, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const APPLIED: LoadOrderOutcome = { outcome: 'applied', status: STATUS };

type Value = LoadOrderSource;

const NO_SNAPSHOT: Value = { gameName: 'Fallout 4', gameRelease: 'Fallout4', loadOrderSnapshot: undefined };

function valueWith(name: string): Value {
  const plugin = { name, path: `/game/Data/${name}`, origin: 'Data' };
  return {
    ...NO_SNAPSHOT,
    loadOrderSnapshot: { plugins: [plugin], active: [{ name, origin: 'Data' }], loadedWithNoLine: [], dataFolder: '/game/Data' },
  };
}

function isPluginInputs(value: unknown): value is LoadOrderPluginInput[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && 'name' in v);
}

function wired(status: 'running' | 'starting', first: Value, outcome: LoadOrderOutcome = APPLIED) {
  const client = new InMemoryMEditClient();
  client.setCommandResult('putLoadOrder', outcome);
  client.setStatus(status);
  const instance = { value: first, sequence: 1, refresh: vi.fn(() => Promise.resolve()) };
  const narrator = { hear: vi.fn(), settled: vi.fn(() => Promise.resolve()) };
  const log = { info: vi.fn(), error: vi.fn() };
  const report = vi.fn();
  const leave = vi.fn();
  const flow = editingFlow({
    client, sender: createLoadOrderSender(client), instance, instanceRoot: '/instance', narrator, log, report, leave,
    progress: { while: (work) => work(), say: () => undefined }, revealLog: () => undefined,
  });
  const putPluginNames = (): string[] => client.calls
    .filter((c) => c.method === 'putLoadOrder')
    .map((c) => {
      const plugins = c.args[0];
      if (!isPluginInputs(plugins)) throw new Error('expected putLoadOrder args[0] to be a plugin array');
      return plugins.map((p) => p.name).join(',');
    });
  const land = (value: Value): void => { instance.value = value; flow.onRecompute(); };
  return { client, flow, instance, narrator, log, report, leave, putPluginNames, land };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('entering editing', () => {
  it('starts the backend, then puts the load order and waits for the reconcile to settle', async () => {
    const { client, flow, narrator, putPluginNames } = wired('running', valueWith('A.esp'));

    await flow.enter();

    expect(client.calls.some((c) => c.method === 'start')).toBe(true);
    expect(putPluginNames()).toEqual(['A.esp']);
    expect(narrator.hear).toHaveBeenCalledWith(STATUS);
    expect(narrator.settled).toHaveBeenCalledWith(7);
  });

  it('leaves editing, putting nothing, when the value carries no snapshot', async () => {
    const { flow, leave, putPluginNames } = wired('running', NO_SNAPSHOT);

    await flow.enter();

    expect(leave).toHaveBeenCalledOnce();
    expect(putPluginNames()).toEqual([]);
  });

  it('leaves editing and says so when the backend did not come up', async () => {
    const { flow, leave, report, putPluginNames } = wired('starting', valueWith('A.esp'));

    await flow.enter();

    expect(leave).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('Backend failed to start'));
    expect(putPluginNames()).toEqual([]);
  });

  it('reads the instance first when no value has landed', async () => {
    const { flow, instance } = wired('running', valueWith('A.esp'));
    instance.sequence = 0;

    await flow.enter();

    expect(instance.refresh).toHaveBeenCalledOnce();
  });

  it('enters again when the backend restarts after a crash', async () => {
    const { client, flow, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    client.setStatus('disconnected');
    client.setStatus('running');
    await settled();

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('enters no more once disposed', async () => {
    const { client, flow, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    flow.dispose();
    client.setStatus('disconnected');
    client.setStatus('running');
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });
});

describe("a put's own outcome", () => {
  it("reports a failed send's message verbatim", async () => {
    const { flow, report } = wired('running', valueWith('A.esp'), { outcome: 'failed', message: 'Failed to send the load order — bad dir' });

    await flow.put();

    expect(report).toHaveBeenCalledWith('Failed to send the load order — bad dir');
  });

  it('says nothing for an abandoned send, which owns no view', async () => {
    const { flow, report, narrator } = wired('running', valueWith('A.esp'), { outcome: 'abandoned' });

    await flow.put();

    expect(report).not.toHaveBeenCalled();
    expect(narrator.hear).not.toHaveBeenCalled();
  });

  it("leaves an applied send's reconcile to the narrator", async () => {
    const { flow, report } = wired('running', valueWith('A.esp'));

    await flow.put();

    expect(report).not.toHaveBeenCalled();
  });

  it('tells nothing without a snapshot', async () => {
    const { flow, report, narrator, log } = wired('running', NO_SNAPSHOT);

    await flow.put();

    expect([report, narrator.hear, log.info].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });
});

describe('the load order is put at every recompute', () => {
  it('puts a load order equal to the last one put', async () => {
    const { flow, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    land(valueWith('A.esp'));
    await settled();
    land(valueWith('B.esp'));
    await settled();

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp', 'B.esp']);
  });

  it('puts nothing without a game folder, and keeps what mEdit holds', async () => {
    const { flow, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    land(NO_SNAPSHOT);
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });

  it('logs a put that throws, since no caller is left to hear it', async () => {
    const { flow, instance, log } = wired('running', valueWith('A.esp'));
    await flow.enter();
    Object.defineProperty(instance, 'value', { get: () => { throw new Error('boom'); } });

    flow.onRecompute();
    await settled();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('puts a value that arrived before mEdit started only when it starts, once', async () => {
    const { client, flow, land, putPluginNames } = wired('starting', valueWith('A.esp'));

    land(valueWith('B.esp'));
    await settled();
    client.setStatus('running');
    await flow.enter();

    expect(putPluginNames()).toEqual(['B.esp']);
  });

  it('puts nothing between the backend going and mEdit next starting', async () => {
    const { client, flow, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    client.setStatus('stopped');
    land(valueWith('B.esp'));
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });

  it('puts on a stream reopen, with no value landing after it', async () => {
    const { client, flow, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    client.reconnected();
    await settled();

    expect(putPluginNames()).toEqual(['A.esp', 'A.esp']);
  });

  it('puts nothing on a stream reopen before mEdit started', async () => {
    const { client, putPluginNames } = wired('running', valueWith('A.esp'));

    client.reconnected();
    await settled();

    expect(putPluginNames()).toEqual([]);
  });

  it('puts nothing once disposed', async () => {
    const { client, flow, land, putPluginNames } = wired('running', valueWith('A.esp'));
    await flow.enter();

    flow.dispose();
    land(valueWith('B.esp'));
    client.reconnected();
    await settled();

    expect(putPluginNames()).toEqual(['A.esp']);
  });
});
