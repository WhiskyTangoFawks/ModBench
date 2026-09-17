import { describe, it, expect } from 'vitest';
import { selectUpgradeCandidates } from '../upgradeCandidates';
import type { DownloadRow } from '../../mo2Codecs/downloads';
import type { InstanceValue } from '../../instance/instance';

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

// The rows this reads are the codec's own: it never looks at the paths the Instance adds.
const valueOf = (
  mods: InstanceValue['mods'], downloads: readonly DownloadRow[] = [],
): { mods: InstanceValue['mods']; downloads: readonly DownloadRow[] } => ({ mods, downloads });

const download = (over: { modID?: string; fileID?: string }): Pick<DownloadRow, 'modID' | 'fileID'> => over;

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
    const value = valueOf([mod({ name: 'A Local Mod' })]); // nexusId undefined
    expect(selectUpgradeCandidates(value, download({}))).toEqual([]);
  });

  it('flags an installedFiles file-id match', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'Harder VATS', version: '2.0', fileIdMatch: true },
    ]);
  });

  it('reports several candidates with no match, preserving order when none matches', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS A', nexusId: '111', version: '1.0' }),
      mod({ name: 'Harder VATS B', nexusId: '111', version: '1.1', installedFiles: [{ modid: '111', fileid: '1' }] }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'Harder VATS A', version: '1.0', fileIdMatch: false },
      { modName: 'Harder VATS B', version: '1.1', fileIdMatch: false },
    ]);
  });

  it('matches through the sidecar named by installationFile when installedFiles does not match', () => {
    const value = valueOf(
      [mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' })],
      [{ name: 'harder-vats-v1.7z', displayName: 'harder-vats-v1.7z', status: 'Downloaded', size: 0, mtimeMs: 0, hasMeta: true, hidden: false, fileID: '999' }],
    );
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'Harder VATS', version: '1.0', fileIdMatch: true },
    ]);
  });

  it('sorts a file-id match first among several candidates', () => {
    const value = valueOf([
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ modid: '111', fileid: '999' }] }),
    ]);
    expect(selectUpgradeCandidates(value, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'The Match', version: '2.0', fileIdMatch: true },
      { modName: 'No Match', version: '1.0', fileIdMatch: false },
    ]);
  });

  it('never consults the download\'s filename to decide a match', () => {
    const value = valueOf([
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ]);
    // The download's own name coincidentally matches the mod's installationFile, but carries a
    // different file id — no match, because filename is never the signal.
    const value2: { mods: InstanceValue['mods']; downloads: readonly DownloadRow[] } = {
      mods: value.mods,
      downloads: [{ name: 'harder-vats-v1.7z', displayName: 'harder-vats-v1.7z', status: 'Downloaded', size: 0, mtimeMs: 0, hasMeta: true, hidden: false, fileID: '111' }],
    };
    expect(selectUpgradeCandidates(value2, download({ modID: '111', fileID: '999' }))).toEqual([
      { modName: 'Harder VATS', version: '1.0', fileIdMatch: false },
    ]);
  });
});
