import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MEditClient } from '..';
import { EMPTY_SNAPSHOT, notificationEventFixture, recordedThrows } from './fixtures';
import { leveledLog } from '../../test/leveledLog';
import { settled } from '../../test/eventually';
import { fakeMEdit, isMark, noContent, runningMEdit } from './fakeMEdit';

type NotificationEvent = ReturnType<typeof notificationEventFixture>;

const encoder = new TextEncoder();
const malformed = encoder.encode('event: rows-changed\ndata: {"kind":"rows-changed"}\n\n');
const setAside = (folder: string, paths: string[] = ['.medit_tmp_aside_x/Patch.esp']): NotificationEvent =>
  notificationEventFixture({ kind: 'files-set-aside', folder, setAside: paths });

function setAsidesHeard(client: MEditClient): { folder: string; paths: readonly string[] }[] {
  const heard: { folder: string; paths: readonly string[] }[] = [];
  client.onFilesSetAside((told) => { if (!isMark(told.folder)) heard.push(told); });
  return heard;
}

const foldersHeard = (client: MEditClient): { readonly folders: readonly string[] } => {
  const heard = setAsidesHeard(client);
  return { get folders() { return heard.map(({ folder }) => folder); } };
};

const npc = { path: '/m/plugin-source/A.esp/Npc.json', text: '{}', version: 1 };
const handedOver = (mEdit: ReturnType<typeof fakeMEdit>) =>
  mEdit.fetch.mock.calls.filter(([request]) => request.url.includes('/unsaved-document')).length;
const unsavedTaken = ['/unsaved-document', noContent] as const;

describe('mEdit\'s notification stream', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('dispatches an event frame and skips a comment-only one', async () => {
    const { client, streams, fire } = await runningMEdit();
    const heard = foldersHeard(client);

    streams[0]?.write(encoder.encode(': connected\n\n'));
    await fire(setAside('/mods/ModA'));

    expect(heard.folders).toEqual(['/mods/ModA']);
  });

  it.each([
    ['the stream ends', [], (mEdit: ReturnType<typeof fakeMEdit>) => { mEdit.streams[0]?.end(); }, 2],
    ['a malformed frame, without dispatching it', [], (mEdit: ReturnType<typeof fakeMEdit>) => { mEdit.streams[0]?.write(malformed); }, 2],
    ['openStream itself rejects', [0], () => undefined, 1],
  ])('reconnects after %s, without a live backend, as a one-shot adapter would be silently killed by a hiccup for the rest of the session', async (_, refusedOpens, drop, opened) => {
    const mEdit = await runningMEdit({ refusedOpens });
    const heard = foldersHeard(mEdit.client);

    drop(mEdit);
    await settled(() => { expect(mEdit.streams).toHaveLength(opened); });
    await mEdit.fire(setAside('/mods/ModB'));

    expect(heard.folders).toEqual(['/mods/ModB']);
  });

  it('a throwing listener is reported as thrown and does not drop the stream, and the listeners after it hear the frame', async () => {
    const log = leveledLog();
    const { sink, threw } = recordedThrows();
    const { client, streams, fire } = await runningMEdit({ log, listenerThrows: sink });
    client.onFilesSetAside(({ folder }) => { if (folder === '/mods/ModA') throw new Error('listener broke'); });
    const heard = foldersHeard(client);

    await fire(setAside('/mods/ModA'));

    expect(heard.folders).toEqual(['/mods/ModA']);
    expect(threw.map((t) => t.detail)).toEqual(['listener broke']);
    expect(log.lines.warn.join('\n')).not.toContain('stream dropped');
    expect(streams).toHaveLength(1);
  });

  it('says a listener recovered once a call of it that threw is followed by one that returns', async () => {
    const { sink, threw, recovered } = recordedThrows();
    const { client, fire } = await runningMEdit({ listenerThrows: sink });
    const listener = vi.fn().mockImplementationOnce(() => { throw new Error('once'); });
    client.onFilesSetAside(listener);

    await fire(setAside('/mods/ModA'));

    expect(threw).toHaveLength(1);
    expect(recovered.filter((called) => called === listener)).toEqual([listener]);
  });

  it('a throwing reopen listener is reported as thrown and does not drop the stream, and the listeners after it hear the reopen', async () => {
    const log = leveledLog();
    const { sink, threw } = recordedThrows();
    const mEdit = await runningMEdit({ log, listenerThrows: sink, routes: [unsavedTaken] });
    mEdit.client.handUnsavedDocument(npc);
    await settled(() => { expect(handedOver(mEdit)).toBe(1); });
    mEdit.client.onDidChange(() => { throw new Error('reopen listener broke'); });

    await mEdit.reopen();

    await settled(() => { expect(handedOver(mEdit)).toBe(2); });
    expect(threw.map((t) => t.detail)).toEqual(['reopen listener broke']);
    expect(log.lines.warn.join('\n')).not.toContain('stream dropped');
  });

  it('aborts the attempt when a malformed frame drops it, so the connection does not stay open', async () => {
    const { streams } = await runningMEdit();

    streams[0]?.write(malformed);

    await settled(() => { expect(streams[0]?.signal.aborted).toBe(true); });
  });

  it('start() is idempotent — a second call while running opens no second stream', async () => {
    const { client, streams, fire } = await runningMEdit();

    await client.start();
    await fire();

    expect(streams).toHaveLength(1);
  });

  it('start() after a stop() taken between attempts opens one stream at once, not a delayed pair, the sleeping loop not waking on its own beside a second loop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mEdit = await runningMEdit({ reconnectDelayMs: 2000 });
    mEdit.streams[0]?.end();
    await vi.advanceTimersByTimeAsync(0);

    await mEdit.exit();
    await mEdit.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mEdit.streams).toHaveLength(2);
  });

  it('whenConnected() settles when the attempt fails, so the caller goes on without progress rather than waiting for a stream it will never get', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const put = vi.fn(() => new Promise<Response>(() => {}));
    const { client } = fakeMEdit({ refusedOpens: [0], reconnectDelayMs: 100_000, routes: [['/load-order', put]] });
    await client.start();

    void client.sendLoadOrder(EMPTY_SNAPSHOT);

    await settled(() => { expect(put).toHaveBeenCalledOnce(); });
  });

  it('announces a reopen after a drop, and not the first open, as a backend the client attached to without owning it can restart under a live status', async () => {
    const mEdit = fakeMEdit();
    const changes: unknown[] = [];
    mEdit.client.onDidChange((change) => changes.push(change));

    await mEdit.start();
    expect(changes).toEqual([undefined]);
    await mEdit.reopen();
    await mEdit.reopen();

    expect(changes).toEqual([undefined, undefined, undefined]);
  });

  it('announces no reopen for the first open after a stop and start', async () => {
    const mEdit = await runningMEdit();
    await mEdit.exit();
    const changes: unknown[] = [];
    mEdit.client.onDidChange((change) => changes.push(change));

    await mEdit.start();
    await mEdit.fire();

    expect(changes).toEqual([undefined]);
  });

  it('announces no reopen for an attempt that failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mEdit = await runningMEdit({ refusedOpens: [1], reconnectDelayMs: 1000 });
    const changes: unknown[] = [];
    mEdit.client.onDidChange((change) => changes.push(change));

    mEdit.streams[0]?.end();
    await vi.advanceTimersByTimeAsync(1000);

    expect(changes).toEqual([]);
  });

  it('stop() aborts the in-flight attempt and stops retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, streams } = await runningMEdit();

    await client.stop();
    expect(streams[0]?.signal.aborted).toBe(true);
    streams[0]?.end();
    await vi.runAllTimersAsync();

    expect(streams).toHaveLength(1);
  });
});

describe('what each kind of notification tells', () => {
  const progress = { mod: 'ModA', modsDone: 1, modsTotal: 2 };

  async function versionInGit(...events: NotificationEvent[]) {
    const mEdit = await runningMEdit({ routes: [['/version-in-git', () => new Promise<Response>(() => {})]] });
    const heard: unknown[] = [];
    void mEdit.client.versionInGit([], { onProgress: (status) => { heard.push(status); } });
    await settled(() => { expect(mEdit.fetch.mock.calls.some(([request]) => request.url.includes('/version-in-git'))).toBe(true); });
    await mEdit.fire(...events);
    return heard;
  }

  it('hands the progress of version in git to the call that asked for it', async () => {
    const heard = await versionInGit(notificationEventFixture({ kind: 'version-in-git-progress', modlistProgress: progress, versionInGitPhase: 'Parsing' }));

    expect(heard).toEqual([{ ...progress, phase: 'Parsing' }]);
  });

  it.each([
    ['load-order-status', async () => {
      const { client, fire } = await runningMEdit();
      await fire(notificationEventFixture({ kind: 'load-order-status' }));
      return client.recordIndexProgress;
    }],
    ['version-in-git-progress', async () => (await versionInGit(notificationEventFixture({ kind: 'version-in-git-progress' }))).at(0)],
    ['files-set-aside', async () => {
      const { client, fire } = await runningMEdit();
      const heard = setAsidesHeard(client);
      await fire(notificationEventFixture({ kind: 'files-set-aside' }));
      return heard.at(0);
    }],
  ])('skips a %s frame missing its payload', async (_kind, heard) => {
    await expect(heard()).resolves.toBeUndefined();
  });

  it('hands a files-set-aside listener the folder and paths a frame off the stream carries', async () => {
    const { client, fire } = await runningMEdit();
    const heard = setAsidesHeard(client);

    await fire(setAside('/mods/ModA'));

    expect(heard).toEqual([{ folder: '/mods/ModA', paths: ['.medit_tmp_aside_x/Patch.esp'] }]);
  });

  it('unsubscribe stops a typed listener', async () => {
    const { client, fire } = await runningMEdit();
    const typed: string[] = [];
    const off = client.onFilesSetAside(({ folder }) => typed.push(folder));

    await fire(setAside('/mods/ModA'));
    off();
    await fire(setAside('/mods/ModB'));

    expect(typed).not.toContain('/mods/ModB');
  });
});
