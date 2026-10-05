import { describe, it, expect, vi } from 'vitest';
import { fakeQuickPick } from '../../drivingLib/test/quickPickDouble';

const { createQuickPick } = vi.hoisted(() => ({ createQuickPick: vi.fn() }));
vi.mock('vscode', () => ({ window: { createQuickPick } }));

import { chooseInstallTarget, selectUpgradeCandidates } from '../installTarget';
import type { DownloadRow, InstanceValue } from '../../instanceLoader/instance';

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const valueOf = (mods: InstanceValue['mods']): { mods: InstanceValue['mods'] } => ({ mods });

const download = (over: { modID?: string; fileID?: string; name?: string }): Pick<DownloadRow, 'modID' | 'fileID' | 'name'> =>
  ({ name: 'foo.7z', ...over });

describe('selectUpgradeCandidates', () => {
  it('is empty when the download carries no mod id', () => {
    const value = valueOf([mod({ name: 'Harder VATS', nexusId: '111' })]);
    expect(selectUpgradeCandidates(value, download({}))).toEqual([]);
  });

  it('is empty when no installed mod carries the download\'s mod id', () => {
    const value = valueOf([mod({ name: 'Harder VATS', nexusId: '111' })]);
    expect(selectUpgradeCandidates(value, download({ modID: '222' }))).toEqual([]);
  });

  it('is empty when no mod id is present, even for a mod with no nexus id of its own', () => {
    const value = valueOf([mod({ name: 'A Local Mod' })]);
    expect(selectUpgradeCandidates(value, download({}))).toEqual([]);
  });

  it('flags an installedFiles file-id match as tier fileId', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'Harder VATS', version: '2.0', tier: 'fileId' },
    ]);
  });

  it('lists a mod sharing only the mod id as tierless, still a candidate', () => {
    const value = valueOf([mod({ name: 'Harder VATS A', nexusId: '111', version: '1.0' })]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'Harder VATS A', version: '1.0', tier: undefined },
    ]);
  });

  it('sorts a file-id match first, tierless mods after', () => {
    const value = valueOf([
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'The Match', version: '2.0', tier: 'fileId' },
      { modName: 'No Match', version: '1.0', tier: undefined },
    ]);
  });

  it('flags a meta.ini installationFile match naming this exact download as tier installationFile', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      { modName: 'Harder VATS', version: '1.0', tier: 'installationFile' },
    ]);
  });

  it('compares the installationFile match case-folded, as the status does', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'Harder-VATS-v1.7Z' }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      { modName: 'Harder VATS', version: '1.0', tier: 'installationFile' },
    ]);
  });

  it('leaves out a mod installed from this file that does not share the mod id', () => {
    const value = valueOf([
      mod({ name: 'Hand Installed', archiveFilename: 'foo.7z' }),
      mod({ name: 'Other Id', nexusId: '222', archiveFilename: 'foo.7z' }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', name: 'foo.7z' }))).toEqual([]);
  });

  it('drops the installationFile tier, listing the mod tierless, when a fileId match exists elsewhere in the pool', () => {
    const value = valueOf([
      mod({ name: 'By Name', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999', name: 'foo.7z' }))).toEqual([
      { modName: 'By File Id', version: '2.0', tier: 'fileId' },
      { modName: 'By Name', version: '1.0', tier: undefined },
    ]);
  });

  it('takes no fileId tier from an archiveFilename that matches the download name when its fileID is absent from installedFiles, and still flags installationFile', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999', name: 'harder-vats-v1.7z' }))).toEqual([
      { modName: 'Harder VATS', version: '1.0', tier: 'installationFile' },
    ]);
  });
});

describe('chooseInstallTarget', () => {
  const row = (over: { modID?: string }) => ({ name: 'foo.7z', path: '/downloads/foo.7z', ...over });
  const pickDouble = () => {
    const double = fakeQuickPick<{ label: string }>();
    createQuickPick.mockReturnValue(double.qp);
    return double;
  };

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
