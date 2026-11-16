import { describe, it, expect, vi } from 'vitest';
import type { PluginLoadFailure } from '../MEditClient';
import { trackProgress } from '../lateness';
import type { RecordIndexProgress } from '../MEditClient';
import { loadOrderStatusEventFixture } from './fixtures';
import { keepers } from './keepers';

const tick = (conflictsComputed: boolean, failures: PluginLoadFailure[] = [], version = 1) =>
  loadOrderStatusEventFixture({ conflictsComputed, failures, version });

const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

describe('the client\'s record index progress', () => {
  it('is undefined before the first tick', () => {
    expect(keepers().standing.progress()).toBeUndefined();
  });

  it('reads the latest tick', () => {
    const client = keepers();

    client.fire(tick(true, [bad]));
    expect(client.standing.progress()).toMatchObject({ settled: true, done: 1, version: 1 });

    client.fire(tick(false));
    expect(client.standing.progress()).toMatchObject({ settled: false, done: 0 });
  });

  it('resets when the backend leaves running, so a restarted process\'s reconcile starts unsettled', () => {
    const client = keepers();
    client.fire(tick(true));

    client.setStatus('disconnected');

    expect(client.standing.progress()).toBeUndefined();
  });

  it('resets when the stream reopens, since it may have reattached to another process', () => {
    const client = keepers();
    client.fire(tick(true));

    client.reconnected();

    expect(client.standing.progress()).toBeUndefined();
  });

  describe('the change event, on a status heard', () => {
    it('is told for each ready status newer than the last settled one, even when its picture is the last\'s', () => {
      const client = keepers();
      const changed = vi.fn();
      client.onDidChange(changed);

      client.fire(tick(true, [], 1));
      client.fire(tick(true, [], 1));
      client.fire(tick(true, [], 2));

      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('is told when a reconcile of the version already settled, as a refresh runs, becomes ready', () => {
      const client = keepers();
      client.fire(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.fire(tick(false, [], 1));
      client.fire(tick(true, [], 1));

      expect(changed).toHaveBeenCalledOnce();
    });

    it('is not told when a sweep over a named change stops validating, as that change was named', () => {
      const client = keepers();
      client.fire(loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 1 }));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.fire(loadOrderStatusEventFixture({ conflictsComputed: true, validating: true, version: 1 }));
      client.fire(loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 1 }));

      expect(changed).not.toHaveBeenCalled();
    });

    it('is not told when a reconcile starts, or while it runs', () => {
      const client = keepers();
      client.fire(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.fire(tick(false, [], 2));
      client.fire(tick(false, [], 2));

      expect(changed).not.toHaveBeenCalled();
    });

    it('is told, with the new failures already readable, when the failures differ, and not when they repeat', () => {
      const client = keepers();
      const seen: unknown[] = [];
      client.onDidChange(() => seen.push(client.standing.progress()?.done));

      client.fire(tick(false, [bad]));
      client.fire(tick(false, [{ ...bad }]));
      client.fire(tick(false));

      expect(seen).toEqual([1, 0]);
    });

    it('is not told of a reset, and the next process\'s versions start over', () => {
      const client = keepers();
      client.fire(tick(true, [], 5));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.setStatus('disconnected');
      expect(changed).not.toHaveBeenCalled();

      client.fire(tick(true, [], 1));
      expect(changed).toHaveBeenCalledOnce();
    });

    it('is told when a refusal arrives, and when it lifts, though no reconcile settled', () => {
      const client = keepers();
      client.fire(tick(false, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.fire(loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', version: 1 }));
      client.fire(loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', version: 1 }));
      expect(changed).toHaveBeenCalledOnce();

      client.fire(tick(false, [], 1));
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('is told when the load order is dropped, and when it is restored', () => {
      const client = keepers();
      client.fire(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      client.fire(loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false, version: 1 }));
      expect(changed).toHaveBeenCalledOnce();

      client.fire(tick(false, [], 1));
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('stops telling a listener once it unsubscribes', () => {
      const client = keepers();
      const changed = vi.fn();
      client.onDidChange(changed).dispose();

      client.fire(tick(true));

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('the record index\'s progress', () => {
    it('is the plugins indexed or failed out of the load order, while it indexes', () => {
      const client = keepers();

      client.fire(loadOrderStatusEventFixture({ conflictsComputed: false, totalPlugins: 3, indexedPlugins: [{ name: 'A.esp', origin: 'Mod' }], failures: [bad] }));

      expect(client.standing.progress()).toEqual({ done: 2, total: 3, version: 1, settled: false });
    });

    it('is settled once the reconcile settles', () => {
      const client = keepers();
      client.fire(tick(false));

      client.fire(tick(true));

      expect(client.standing.progress()?.settled).toBe(true);
    });

    it('carries the reason mEdit refuses the load order', () => {
      const client = keepers();

      client.fire(loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', conflictsComputed: false }));

      expect(client.standing.progress()?.refusal).toEqual({ kind: 'heldElsewhere', message: 'another window holds the record index' });
    });

    it.each([
      ['the load order is dropped', (client: ReturnType<typeof keepers>) => { client.fire(loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false })); }],
      ['the process is gone', (client: ReturnType<typeof keepers>) => { client.setStatus('disconnected'); }],
    ])('is none once %s', (_case, end) => {
      const client = keepers();
      client.fire(tick(false));

      end(client);

      expect(client.standing.progress()).toBeUndefined();
    });
  });
});

describe('the progress told to a listener', () => {
  it('is told only when it changes', () => {
    const held: { progress?: RecordIndexProgress } = {};
    const told = vi.fn();
    const tracked = trackProgress(() => held.progress);
    tracked.event(told);

    tracked.note();
    held.progress = { done: 1, total: 2, version: 1, settled: false };
    tracked.note();
    tracked.note();

    expect(told.mock.calls).toEqual([[{ done: 1, total: 2, version: 1, settled: false }]]);
  });
});
