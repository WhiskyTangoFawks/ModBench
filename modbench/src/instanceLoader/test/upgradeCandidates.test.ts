import { describe, it, expect } from 'vitest';
import { buildDownloadRows } from '../downloadRows';
import type { DownloadedFile } from '../../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instance';

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const download = (over: { modID?: string; fileID?: string; name?: string }): DownloadedFile => {
  const { name = 'foo.7z', ...ids } = over;
  return {
    name, path: `/downloads/${name}`, metaPath: `/downloads/${name}.meta`, size: 1, mtimeMs: 1,
    meta: { status: 'Downloaded', excluded: false, ...ids },
  };
};

const offered = (mods: InstanceValue['mods'], file: DownloadedFile) => {
  const rows = buildDownloadRows([file], new Map(), mods);
  expect(rows).toHaveLength(1);
  return rows.flatMap((row) => row.upgrades).map((c) => [c.modName, c.tier]);
};

describe('the upgrade candidates of a download', () => {
  it('is empty when the download carries no mod id', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111' })];
    expect(offered(value, download({}))).toEqual([]);
  });

  it('is empty when no installed mod carries the download\'s mod id', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111' })];
    expect(offered(value, download({ modID: '222' }))).toEqual([]);
  });

  it('is empty when no mod id is present, even for a mod with no nexus id of its own', () => {
    const value = [mod({ name: 'A Local Mod' })];
    expect(offered(value, download({}))).toEqual([]);
  });

  it('flags an installedFiles file-id match as tier fileId', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ];
    expect(offered(value, download({ modID: '111', fileID: '999' }))).toEqual([
      ['Harder VATS', 'fileId'],
    ]);
  });

  it('lists a mod sharing only the mod id as unmarked, still a candidate', () => {
    const value = [mod({ name: 'Harder VATS A', nexusId: '111', version: '1.0' })];
    expect(offered(value, download({ modID: '111', fileID: '999' }))).toEqual([
      ['Harder VATS A', undefined],
    ]);
  });

  it('sorts a file-id match first, unmarked mods after', () => {
    const value = [
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ];
    expect(offered(value, download({ modID: '111', fileID: '999' }))).toEqual([
      ['The Match', 'fileId'],
      ['No Match', undefined],
    ]);
  });

  it('flags a meta.ini archiveFilename match naming this exact download as tier archiveFilename', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ];
    expect(offered(value, download({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS', 'archiveFilename'],
    ]);
  });

  it('compares the archiveFilename match case-folded, as the status does', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'Harder-VATS-v1.7Z' }),
    ];
    expect(offered(value, download({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS', 'archiveFilename'],
    ]);
  });

  it('leaves out a mod installed from this file that does not share the mod id', () => {
    const value = [
      mod({ name: 'Hand Installed', archiveFilename: 'foo.7z' }),
      mod({ name: 'Other Id', nexusId: '222', archiveFilename: 'foo.7z' }),
    ];
    expect(offered(value, download({ modID: '111', name: 'foo.7z' }))).toEqual([]);
  });

  it('drops the archiveFilename tier, listing the mod unmarked, when a fileId match exists elsewhere in the pool', () => {
    const value = [
      mod({ name: 'By Name', nexusId: '111', version: '1.0', archiveFilename: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFiles: [{ nexusId: '111', fileId: '999' }] }),
    ];
    expect(offered(value, download({ modID: '111', fileID: '999', name: 'foo.7z' }))).toEqual([
      ['By File Id', 'fileId'],
      ['By Name', undefined],
    ]);
  });

  it('takes no fileId tier from an archiveFilename that matches the download name when its fileID is absent from installedFiles, and still flags archiveFilename', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', archiveFilename: 'harder-vats-v1.7z' }),
    ];
    expect(offered(value, download({ modID: '111', fileID: '999', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS', 'archiveFilename'],
    ]);
  });
});
