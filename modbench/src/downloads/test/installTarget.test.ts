import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';

const { createQuickPick } = vi.hoisted(() => ({ createQuickPick: vi.fn() }));
vi.mock('vscode', () => ({ window: { createQuickPick } }));

import { chooseInstallTarget } from '../installTarget';
import type { DownloadRow, InstanceValue } from '../../instanceLoader/instance';

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const valueOf = (mods: InstanceValue['mods']): { mods: InstanceValue['mods'] } => ({ mods });

const download = (over: { modID?: string; fileID?: string; name?: string }): Pick<DownloadRow, 'modID' | 'fileID' | 'name'> =>
  ({ name: 'foo.7z', ...over });

beforeEach(() => createQuickPick.mockClear());

const pickDouble = () => {
  const double = fakeQuickPick<{ label: string; description?: string }>();
  createQuickPick.mockReturnValue(double.qp);
  return double;
};

const offered = async (value: ReturnType<typeof valueOf>, row: Pick<DownloadRow, 'modID' | 'fileID' | 'name'>) => {
  const double = pickDouble();
  const result = chooseInstallTarget(value, { path: '/downloads/foo.7z', ...row }, vi.fn().mockResolvedValue(undefined));
  if (createQuickPick.mock.calls.length === 0) {
    await result;
    return [];
  }
  await vi.waitFor(() => expect(double.qp.show).toHaveBeenCalled());
  const upgrades = double.qp.items.slice(0, -1).map((item) => [item.label, item.description]);
  double.escape();
  await result;
  return upgrades;
};

describe('the mods offered as the upgrade of a download', () => {
  it('is empty when the download carries no mod id', async () => {
    const value = valueOf([mod({ name: 'Harder VATS', nexusId: '111' })]);
    expect(await offered(value, download({}))).toEqual([]);
  });

  it('is empty when no installed mod carries the download\'s mod id', async () => {
    const value = valueOf([mod({ name: 'Harder VATS', nexusId: '111' })]);
    expect(await offered(value, download({ modID: '222' }))).toEqual([]);
  });

  it('is empty when no mod id is present, even for a mod with no nexus id of its own', async () => {
    const value = valueOf([mod({ name: 'A Local Mod' })]);
    expect(await offered(value, download({}))).toEqual([]);
  });

  it('flags an installedFiles file-id match as tier fileId', async () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ]);
    expect(await offered(value, download({ modID: '111', fileID: '999' }))).toEqual([
      ['Harder VATS (v2.0)', 'File ID match'],
    ]);
  });

  it('lists a mod sharing only the mod id as unmarked, still a candidate', async () => {
    const value = valueOf([mod({ name: 'Harder VATS A', nexusId: '111', version: '1.0' })]);
    expect(await offered(value, download({ modID: '111', fileID: '999' }))).toEqual([
      ['Harder VATS A (v1.0)', undefined],
    ]);
  });

  it('sorts a file-id match first, unmarked mods after', async () => {
    const value = valueOf([
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ]);
    expect(await offered(value, download({ modID: '111', fileID: '999' }))).toEqual([
      ['The Match (v2.0)', 'File ID match'],
      ['No Match (v1.0)', undefined],
    ]);
  });

  it('flags a meta.ini archiveFilename match naming this exact download as tier archiveFilename', async () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ]);
    expect(await offered(value, download({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS (v1.0)', 'Installed from this file'],
    ]);
  });

  it('compares the archiveFilename match case-folded, as the status does', async () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'Harder-VATS-v1.7Z' }),
    ]);
    expect(await offered(value, download({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS (v1.0)', 'Installed from this file'],
    ]);
  });

  it('leaves out a mod installed from this file that does not share the mod id', async () => {
    const value = valueOf([
      mod({ name: 'Hand Installed', archiveFilename: 'foo.7z' }),
      mod({ name: 'Other Id', nexusId: '222', archiveFilename: 'foo.7z' }),
    ]);
    expect(await offered(value, download({ modID: '111', name: 'foo.7z' }))).toEqual([]);
  });

  it('drops the archiveFilename tier, listing the mod unmarked, when a fileId match exists elsewhere in the pool', async () => {
    const value = valueOf([
      mod({ name: 'By Name', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ]);
    expect(await offered(value, download({ modID: '111', fileID: '999', name: 'foo.7z' }))).toEqual([
      ['By File Id (v2.0)', 'File ID match'],
      ['By Name (v1.0)', undefined],
    ]);
  });

  it('takes no fileId tier from an archiveFilename that matches the download name when its fileID is absent from installedFiles, and still flags archiveFilename', async () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ]);
    expect(await offered(value, download({ modID: '111', fileID: '999', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS (v1.0)', 'Installed from this file'],
    ]);
  });
});

describe('chooseInstallTarget', () => {
  const row = (over: { modID?: string }) => ({ name: 'foo.7z', path: '/downloads/foo.7z', ...over });

  it('asks for a new mod name, with no pick, when no mod shares the mod id', async () => {
    const nameNewMod = vi.fn().mockResolvedValue('Foo');
    const value = valueOf([mod({ name: 'Hand Installed', archiveFilename: 'foo.7z' })]);
    expect(await chooseInstallTarget(value, row({ modID: '111' }), nameNewMod)).toEqual({ kind: 'new', name: 'Foo' });
    expect(nameNewMod).toHaveBeenCalledWith('foo');
    expect(createQuickPick).not.toHaveBeenCalled();
  });

  it('takes an upgrade from the pick without asking for a name', async () => {
    const double = pickDouble();
    const nameNewMod = vi.fn();
    const result = chooseInstallTarget(valueOf([mod({ name: 'Harder VATS', nexusId: '111' })]), row({ modID: '111' }), nameNewMod);
    await vi.waitFor(() => expect(double.qp.show).toHaveBeenCalled());
    const upgrade = double.qp.items.find((item) => item.label === 'Harder VATS');
    if (!upgrade) throw new Error('the pick lists the mod');
    double.accept(upgrade);
    expect(await result).toEqual({ kind: 'upgrade', name: 'Harder VATS' });
    expect(nameNewMod).not.toHaveBeenCalled();
  });

  it('installs nothing on Esc', async () => {
    const double = pickDouble();
    const result = chooseInstallTarget(valueOf([mod({ name: 'Harder VATS', nexusId: '111' })]), row({ modID: '111' }), vi.fn());
    await vi.waitFor(() => expect(double.qp.show).toHaveBeenCalled());
    double.escape();
    expect(await result).toBeUndefined();
  });
});
