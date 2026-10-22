import { describe, it, expect } from 'vitest';
import { buildDownloadedFileRows } from '../downloadedFileRows';
import type { DownloadedFile } from '../../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instance';

const mod = (over: Partial<InstanceValue['mods'][number]> & { name: string }): InstanceValue['mods'][number] => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const downloadedFile = (over: { modID?: string; modIDFromName?: string; installedKey?: string; name?: string }): DownloadedFile => {
  const { name = 'foo.7z', modIDFromName, ...ids } = over;
  return {
    name, path: `/downloads/${name}`, metadataPath: `/downloads/${name}.meta`, size: 1, mtimeMs: 1, excluded: false,
    meta: { status: 'Downloaded', ...ids },
    modIDFromName,
  };
};

const offered = (mods: InstanceValue['mods'], file: DownloadedFile) => {
  const rows = buildDownloadedFileRows([file], new Map(), mods);
  expect(rows).toHaveLength(1);
  return rows.flatMap((row) => row.upgrades).map((c) => [c.modName, c.tier]);
};

describe('the upgrade candidates of a downloaded file', () => {
  it('is empty when the downloaded file carries no mod id', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111' })];
    expect(offered(value, downloadedFile({}))).toEqual([]);
  });

  it('takes the mod id from the file name when the metadata has none', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111' })];
    expect(offered(value, downloadedFile({ modIDFromName: '111' }))).toEqual([['Harder VATS', undefined]]);
  });

  it('prefers the metadata\'s mod id to the file name\'s', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111' }), mod({ name: 'Other', nexusId: '222' })];
    expect(offered(value, downloadedFile({ modID: '111', modIDFromName: '222' }))).toEqual([['Harder VATS', undefined]]);
  });

  it('is empty when no installed mod carries the downloaded file\'s mod id', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111' })];
    expect(offered(value, downloadedFile({ modID: '222' }))).toEqual([]);
  });

  it('is empty when no mod id is present, even for a mod with no nexus id of its own', () => {
    const value = [mod({ name: 'A Local Mod' })];
    expect(offered(value, downloadedFile({}))).toEqual([]);
  });

  it('flags an installed-file key match as tier fileId', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFileKeys: ['key-999'] }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', installedKey: 'key-999' }))).toEqual([
      ['Harder VATS', 'fileId'],
    ]);
  });

  it('takes no fileId tier from a key of another mod\'s file, which shares only the file id', () => {
    const value = [mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFileKeys: ['other-mod-999'] })];
    expect(offered(value, downloadedFile({ modID: '111', installedKey: 'this-mod-999' }))).toEqual([
      ['Harder VATS', undefined],
    ]);
  });

  it('lists a mod sharing only the mod id as unmarked, still a candidate', () => {
    const value = [mod({ name: 'Harder VATS A', nexusId: '111', version: '1.0' })];
    expect(offered(value, downloadedFile({ modID: '111', installedKey: 'key-999' }))).toEqual([
      ['Harder VATS A', undefined],
    ]);
  });

  it('sorts a file-id match first, unmarked mods after', () => {
    const value = [
      mod({ name: 'No Match', nexusId: '111', version: '1.0' }),
      mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFileKeys: ['key-999'] }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', installedKey: 'key-999' }))).toEqual([
      ['The Match', 'fileId'],
      ['No Match', undefined],
    ]);
  });

  it('flags a meta.ini installationFileName match naming this exact downloaded file as tier installationFileName', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', installationFileName: 'harder-vats-v1.7z' }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS', 'installationFileName'],
    ]);
  });

  it('compares the installationFileName match case-folded, as the status does', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', installationFileName: 'Harder-VATS-v1.7Z' }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS', 'installationFileName'],
    ]);
  });

  it('leaves out a mod installed from this file that does not share the mod id', () => {
    const value = [
      mod({ name: 'Hand Installed', installationFileName: 'foo.7z' }),
      mod({ name: 'Other Id', nexusId: '222', installationFileName: 'foo.7z' }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', name: 'foo.7z' }))).toEqual([]);
  });

  it('drops the installationFileName tier, listing the mod unmarked, when a fileId match exists elsewhere in the pool', () => {
    const value = [
      mod({ name: 'By Name', nexusId: '111', version: '1.0', installationFileName: 'foo.7z' }),
      mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFileKeys: ['key-999'] }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', installedKey: 'key-999', name: 'foo.7z' }))).toEqual([
      ['By File Id', 'fileId'],
      ['By Name', undefined],
    ]);
  });

  it('takes no fileId tier from an installationFileName that matches the downloaded file name when its key is absent from the installed files of the mod, and still flags installationFileName', () => {
    const value = [
      mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', installationFileName: 'harder-vats-v1.7z' }),
    ];
    expect(offered(value, downloadedFile({ modID: '111', installedKey: 'key-999', name: 'harder-vats-v1.7z' }))).toEqual([
      ['Harder VATS', 'installationFileName'],
    ]);
  });
});
