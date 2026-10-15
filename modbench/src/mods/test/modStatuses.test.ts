import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import type { ModStatus } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ReadFailed } from '../../wire/readFailed';
import { ModStatuses, type ReadStatus } from '../modStatuses';
import { status } from './modStatusFixture';

const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const UNREACHABLE: ReadFailed = { failed: 'unreachable' };

function statusesOver(read: ReadStatus, mods: readonly string[] = []) {
  const client = new InMemoryMEditClient();
  const logged: string[] = [];
  const statuses = new ModStatuses(client, read, (line) => { logged.push(line); }, () => mods);
  const pushed = async (...names: string[]) => {
    client.emit({ kind: 'mod-status-changed', plugin: '', origin: '', keys: [], sequence: 0, mods: names });
    await settled();
  };
  const reconnected = async () => {
    client.reconnected();
    await settled();
  };
  return { statuses, logged, pushed, reconnected };
}

const unreadable = (mod: string, why: string): ModStatus => status(mod, { unreadable: { manifest: false, why } });

describe('each mod\'s status (modlist-source.md, Status)', () => {
  it('is read for each mod mEdit pushes as changed, and held until the next push names it', async () => {
    const read = vi.fn<ReadStatus>()
      .mockResolvedValueOnce([status('ModA', { noManifest: true }), status('ModB')])
      .mockResolvedValueOnce([status('ModB', { differing: ['a.nif'] })]);
    const { statuses, pushed } = statusesOver(read);

    await pushed('ModA', 'ModB');
    await pushed('ModB');

    expect(read.mock.calls).toEqual([[['ModA', 'ModB']], [['ModB']]]);
    expect([statuses.of('ModA'), statuses.of('ModB')]).toEqual([status('ModA', { noManifest: true }), status('ModB', { differing: ['a.nif'] })]);
  });

  it('is read for every mod when the stream opens again, since a push made while it was down is lost', async () => {
    const read = vi.fn<ReadStatus>().mockResolvedValue([status('ModA'), status('ModB')]);
    const { statuses, reconnected } = statusesOver(read, ['ModA', 'ModB']);

    await reconnected();

    expect([read.mock.calls, statuses.of('ModB')]).toEqual([[[['ModA', 'ModB']]], status('ModB')]);
  });

  it('keeps the answer to the later push when an earlier read answers last', async () => {
    let answerFirst!: (answer: readonly ModStatus[]) => void;
    const read = vi.fn<ReadStatus>()
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
    const read = vi.fn<ReadStatus>()
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
    const read = vi.fn<ReadStatus>()
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
    const read = vi.fn<ReadStatus>()
      .mockResolvedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce([unreadable('ModA', 'EACCES')])
      .mockResolvedValueOnce([unreadable('ModA', 'EACCES')]);
    const { logged, pushed } = statusesOver(read);

    await pushed('ModA');
    await pushed('ModA');
    await pushed('ModA');
    await pushed('ModA');

    expect(logged).toEqual(['The mods\' status could not be read: mEdit could not be reached.', 'The status of "ModA" could not be read: EACCES']);
  });

  it('logs a stat cache mEdit could not write, and shows the status it read', async () => {
    const { statuses, logged, pushed } = statusesOver(() => Promise.resolve([status('ModA', { statCacheNotWritten: 'EROFS' })]));

    await pushed('ModA');

    expect([logged, statuses.message()]).toEqual([['"ModA": the stat cache could not be written: EROFS'], undefined]);
  });
});
