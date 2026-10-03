import { describe, it, expect } from 'vitest';
import { selectUpgradeCandidates } from '../upgradeCandidates';
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

  it('flags an installationFile match from a hand-installed mod with no Nexus mod id of its own, on its meta.ini record alone', () => {
    const value = valueOf([mod({ name: 'Hand Installed', archiveFilename: 'foo.7z' })]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', name: 'foo.7z' }))).toEqual([
      { modName: 'Hand Installed', version: undefined, tier: 'installationFile' },
    ]);
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
