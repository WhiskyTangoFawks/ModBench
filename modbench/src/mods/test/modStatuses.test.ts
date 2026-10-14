import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import type { ModStatus } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ReadFailed } from '../../wire/readFailed';
import { ModStatuses, type ReadStatus } from '../modStatuses';

const status = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, noManifest: false, differing: [], namedByNoLine: [], gone: [], noProvider: [], ...over });

const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function statusesOver(read: ReadStatus) {
  const client = new InMemoryMEditClient();
  const logged: string[] = [];
  const statuses = new ModStatuses(client, read, (line) => { logged.push(line); });
  const pushed = async (...mods: string[]) => {
    client.emit({ kind: 'mod-status-changed', plugin: '', origin: '', keys: [], sequence: 0, mods });
    await settled();
  };
  return { statuses, logged, pushed };
}

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

  it('logs a read that failed, and a mod whose status could not be read', async () => {
    const failed: ReadFailed = { failed: 'unreachable' };
    const read = vi.fn<ReadStatus>()
      .mockResolvedValueOnce([status('ModA', { unreadable: 'a file could not be read: EACCES' })])
      .mockResolvedValueOnce(failed);
    const { logged, pushed } = statusesOver(read);

    await pushed('ModA');
    await pushed('ModA');

    expect(logged).toEqual([
      'The status of "ModA" could not be read: a file could not be read: EACCES', 'Could not read the mods\' status: mEdit could not be reached.',
    ]);
  });
});
