import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import type { ModStatus } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ReadFailed } from '../../wire/readFailed';
import { ModStatuses } from '../modStatuses';
import type { ReadModStatus } from '../../client';
import { status } from '../../test/modStatusFixture';

const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const UNREACHABLE: ReadFailed = { failed: 'unreachable' };

function statusesOver(read: ReadModStatus) {
  const client = new InMemoryMEditClient();
  const logged: string[] = [];
  const statuses = new ModStatuses(client, read, (line) => { logged.push(line); });
  const pushed = async (...names: string[]) => {
    client.emit({ kind: 'mod-status-changed', plugin: '', origin: '', keys: [], sequence: 0, mods: names });
    await settled();
  };
  return { statuses, logged, pushed };
}

const unreadable = (mod: string, why: string): ModStatus => status(mod, { unreadable: { manifest: false, why } });

describe('each mod\'s status (modlist-repository.md, Status)', () => {
  it('is read for each mod mEdit pushes as changed, and held until the next push names it', async () => {
    const read = vi.fn<ReadModStatus>()
      .mockResolvedValueOnce([status('ModA', { noManifest: true }), status('ModB')])
      .mockResolvedValueOnce([status('ModB', { differing: ['a.nif'] })]);
    const { statuses, pushed } = statusesOver(read);

    await pushed('ModA', 'ModB');
    await pushed('ModB');

    expect(read.mock.calls).toEqual([[['ModA', 'ModB']], [['ModB']]]);
    expect([statuses.of('ModA'), statuses.of('ModB')]).toEqual([status('ModA', { noManifest: true }), status('ModB', { differing: ['a.nif'] })]);
  });

  it('keeps the answer to the later push when an earlier read answers last', async () => {
    let answerFirst!: (answer: readonly ModStatus[]) => void;
    const read = vi.fn<ReadModStatus>()
      .mockReturnValueOnce(new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValueOnce([status('ModA')]);
    const { statuses, pushed } = statusesOver(read);

    void pushed('ModA');
    await pushed('ModA');
    answerFirst([status('ModA', { noManifest: true })]);
    await settled();

    expect(statuses.of('ModA')).toEqual(status('ModA'));
  });

  it('says it changed once an answer lands', async () => {
    const { statuses, pushed } = statusesOver(() => Promise.resolve([status('ModA')]));
    const heard = vi.fn();
    statuses.onDidChange(heard);

    await pushed('ModA');

    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('a status read that fails (common.md, Reporting)', () => {
  it('keeps each mod\'s last status, says so on the message line, and clears it once a read lands', async () => {
    const read = vi.fn<ReadModStatus>()
      .mockResolvedValueOnce([status('ModA', { noManifest: true })])
      .mockResolvedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce([status('ModA')]);
    const { statuses, pushed } = statusesOver(read);
    await pushed('ModA');

    await pushed('ModA');
    const failed = [statuses.of('ModA'), statuses.message()];
    await pushed('ModA');

    expect([...failed, statuses.message()]).toEqual([
      status('ModA', { noManifest: true }), 'Showing the last good read: the mods\' status could not be read: mEdit could not be reached.', undefined,
    ]);
  });

  it('keeps an unreadable mod\'s last status, and the message line names it until its status reads', async () => {
    const read = vi.fn<ReadModStatus>()
      .mockResolvedValueOnce([status('ModA', { noManifest: true })])
      .mockResolvedValueOnce([unreadable('ModA', 'a file could not be read: EACCES')])
      .mockResolvedValueOnce([status('ModA')]);
    const { statuses, pushed } = statusesOver(read);
    await pushed('ModA');

    await pushed('ModA');
    const failed = [statuses.of('ModA'), statuses.message()];
    await pushed('ModA');

    expect([...failed, statuses.message(), statuses.of('ModA')]).toEqual([
      status('ModA', { noManifest: true }), 'Showing the last good read: the status of "ModA" could not be read: a file could not be read: EACCES.',
      undefined, status('ModA'),
    ]);
  });

  it('logs each reason once in the Output, and again only when it changes', async () => {
    const read = vi.fn<ReadModStatus>()
      .mockResolvedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce([unreadable('ModA', 'EACCES')])
      .mockResolvedValueOnce([unreadable('ModA', 'EACCES')]);
    const { logged, pushed } = statusesOver(read);

    await pushed('ModA');
    await pushed('ModA');
    await pushed('ModA');
    await pushed('ModA');

    expect(logged).toEqual(['The status of "ModA" could not be read: EACCES']);
  });

  it('shows the status of a mod whose stat cache mEdit could not write, and says so on the message line until it writes', async () => {
    const read = vi.fn<ReadModStatus>()
      .mockResolvedValueOnce([status('ModA', { noManifest: true, statCacheNotWritten: 'EROFS' })])
      .mockResolvedValueOnce([status('ModA')]);
    const { statuses, pushed } = statusesOver(read);

    await pushed('ModA');
    const unwritten = [statuses.of('ModA'), statuses.message()];
    await pushed('ModA');

    expect([...unwritten, statuses.message()]).toEqual([
      status('ModA', { noManifest: true, statCacheNotWritten: 'EROFS' }), 'The stat cache of "ModA" could not be written: EROFS.', undefined,
    ]);
  });

  it('logs a stat cache mEdit could not write once in the Output, and again only when the reason changes', async () => {
    const read = vi.fn<ReadModStatus>()
      .mockResolvedValueOnce([status('ModA', { statCacheNotWritten: 'EROFS' })])
      .mockResolvedValueOnce([status('ModA', { statCacheNotWritten: 'EROFS' })])
      .mockResolvedValueOnce([status('ModA', { statCacheNotWritten: 'ENOSPC' })]);
    const { logged, pushed } = statusesOver(read);

    await pushed('ModA');
    await pushed('ModA');
    await pushed('ModA');

    expect(logged).toEqual(['"ModA": the stat cache could not be written: EROFS', '"ModA": the stat cache could not be written: ENOSPC']);
  });
});
