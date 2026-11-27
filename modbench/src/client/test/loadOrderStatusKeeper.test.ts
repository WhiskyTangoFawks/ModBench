import { describe, it, expect, vi } from 'vitest';
import type { PluginLoadFailure, RecordIndexProgress } from '..';
import { loadOrderStatusEventFixture } from './fixtures';
import { runningMEdit } from './fakeMEdit';

const tick = (conflictsComputed: boolean, failures: PluginLoadFailure[] = [], version = 1) =>
  loadOrderStatusEventFixture({ conflictsComputed, failures, version });

const bad = { name: 'Bad.esp', origin: 'Mod', reason: 'truncated' };

describe('the client\'s record index progress', () => {
  it('is undefined before the first tick', async () => {
    const { client } = await runningMEdit();

    expect(client.recordIndexProgress).toBeUndefined();
  });

  it('reads the latest tick', async () => {
    const { client, fire } = await runningMEdit();

    await fire(tick(true, [bad]));
    expect(client.recordIndexProgress).toMatchObject({ settled: true, done: 1, version: 1 });

    await fire(tick(false));
    expect(client.recordIndexProgress).toMatchObject({ settled: false, done: 0 });
  });

  it('resets when the backend leaves running, so a restarted process\'s reconcile starts unsettled', async () => {
    const { client, fire, exit } = await runningMEdit();
    await fire(tick(true));

    await exit();

    expect(client.recordIndexProgress).toBeUndefined();
  });

  it('resets when the stream reopens, since it may have reattached to another process', async () => {
    const { client, fire, reopen } = await runningMEdit();
    await fire(tick(true));

    await reopen();

    expect(client.recordIndexProgress).toBeUndefined();
  });

  describe('the change event, on a status heard', () => {
    it('is told for each ready status newer than the last settled one, even when its picture is the last\'s', async () => {
      const { client, fire } = await runningMEdit();
      const changed = vi.fn();
      client.onDidChange(changed);

      await fire(tick(true, [], 1), tick(true, [], 1), tick(true, [], 2));

      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('is told when a reconcile of the version already settled, as a refresh runs, becomes ready', async () => {
      const { client, fire } = await runningMEdit();
      await fire(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      await fire(tick(false, [], 1), tick(true, [], 1));

      expect(changed).toHaveBeenCalledOnce();
    });

    it('is not told when a sweep over a named change stops validating, as that change was named', async () => {
      const { client, fire } = await runningMEdit();
      await fire(loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 1 }));
      const changed = vi.fn();
      client.onDidChange(changed);

      await fire(
        loadOrderStatusEventFixture({ conflictsComputed: true, validating: true, version: 1 }),
        loadOrderStatusEventFixture({ conflictsComputed: true, validating: false, version: 1 }),
      );

      expect(changed).not.toHaveBeenCalled();
    });

    it('is not told when a reconcile starts, or while it runs', async () => {
      const { client, fire } = await runningMEdit();
      await fire(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      await fire(tick(false, [], 2), tick(false, [], 2));

      expect(changed).not.toHaveBeenCalled();
    });

    it('is told, with the new failures already readable, when the failures differ, and not when they repeat', async () => {
      const { client, fire } = await runningMEdit();
      const seen: unknown[] = [];
      client.onDidChange(() => seen.push(client.recordIndexProgress?.done));

      await fire(tick(false, [bad]), tick(false, [{ ...bad }]), tick(false));

      expect(seen).toEqual([1, 0]);
    });

    it('is not told of a reset, and the next process\'s versions start over', async () => {
      const mEdit = await runningMEdit();
      await mEdit.fire(tick(true, [], 5));
      const changed = vi.fn();
      mEdit.client.onDidChange(changed);

      await mEdit.exit();
      expect(changed).not.toHaveBeenCalled();

      await mEdit.start();
      changed.mockClear();
      await mEdit.fire(tick(true, [], 1));
      expect(changed).toHaveBeenCalledOnce();
    });

    it('is told when a refusal arrives, and when it lifts, though no reconcile settled', async () => {
      const { client, fire } = await runningMEdit();
      await fire(tick(false, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);
      const heldElsewhere = loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', version: 1 });

      await fire(heldElsewhere, heldElsewhere);
      expect(changed).toHaveBeenCalledOnce();

      await fire(tick(false, [], 1));
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('is told when the load order is dropped, and when it is restored', async () => {
      const { client, fire } = await runningMEdit();
      await fire(tick(true, [], 1));
      const changed = vi.fn();
      client.onDidChange(changed);

      await fire(loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false, version: 1 }));
      expect(changed).toHaveBeenCalledOnce();

      await fire(tick(false, [], 1));
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it('stops telling a listener once it unsubscribes', async () => {
      const { client, fire } = await runningMEdit();
      const changed = vi.fn();
      client.onDidChange(changed).dispose();

      await fire(tick(true));

      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('the record index\'s progress', () => {
    it('is the plugins indexed or failed out of the load order, while it indexes', async () => {
      const { client, fire } = await runningMEdit();

      await fire(loadOrderStatusEventFixture({ conflictsComputed: false, totalPlugins: 3, indexedPlugins: [{ name: 'A.esp', origin: 'Mod' }], failures: [bad] }));

      expect(client.recordIndexProgress).toEqual({ done: 2, total: 3, version: 1, settled: false });
    });

    it('is settled once the reconcile settles', async () => {
      const { client, fire } = await runningMEdit();
      await fire(tick(false));

      await fire(tick(true));

      expect(client.recordIndexProgress?.settled).toBe(true);
    });

    it('carries the reason mEdit refuses the load order', async () => {
      const { client, fire } = await runningMEdit();

      await fire(loadOrderStatusEventFixture({ state: 'HeldElsewhere', message: 'another window holds the record index', conflictsComputed: false }));

      expect(client.recordIndexProgress?.refusal).toEqual({ kind: 'heldElsewhere', message: 'another window holds the record index' });
    });

    it.each([
      ['the load order is dropped', (mEdit: Awaited<ReturnType<typeof runningMEdit>>) => mEdit.fire(loadOrderStatusEventFixture({ state: 'None', conflictsComputed: false }))],
      ['the process is gone', (mEdit: Awaited<ReturnType<typeof runningMEdit>>) => mEdit.exit()],
    ])('is none once %s', async (_case, end) => {
      const mEdit = await runningMEdit();
      await mEdit.fire(tick(false));

      await end(mEdit);

      expect(mEdit.client.recordIndexProgress).toBeUndefined();
    });
  });
});

describe('the progress told to a listener', () => {
  it('is told only when it changes', async () => {
    const { client, fire } = await runningMEdit();
    const told: (RecordIndexProgress | undefined)[] = [];
    client.onDidChangeRecordIndexProgress((progress) => { told.push(progress); });
    const halfway = loadOrderStatusEventFixture({ conflictsComputed: false, totalPlugins: 2, indexedPlugins: [{ name: 'A.esp', origin: 'Mod' }] });

    await fire(halfway, halfway);

    expect(told).toEqual([{ done: 1, total: 2, version: 1, settled: false }]);
  });
});
