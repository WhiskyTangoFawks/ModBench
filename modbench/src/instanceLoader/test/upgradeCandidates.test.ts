import { describe, it, expect } from 'vitest';
import { buildDownloadedFileRows } from '../downloadedFileRows';
import type { DownloadedFile } from '../../instanceAdapter/instanceAdapter';
import type { InstanceValue } from '../instance';

type Mod = InstanceValue['mods'][number];

const mod = (over: Partial<Mod> & { name: string }): Mod => ({
  kind: 'mod',
  enabled: true,
  ...over,
});

const downloadedFile = (over: { modID?: string; installedKey?: string; name?: string }): DownloadedFile => {
  const { name = 'foo.7z', ...ids } = over;
  return {
    name, path: `/downloads/${name}`, metadataPath: `/downloads/${name}.meta`, size: 1, mtimeMs: 1, excluded: false,
    meta: { status: 'Downloaded', ...ids },
    modID: ids.modID,
  };
};

const offered = (mods: InstanceValue['mods'], file: DownloadedFile) => {
  const rows = buildDownloadedFileRows([file], new Map(), mods);
  expect(rows).toHaveLength(1);
  return rows.flatMap((row) => row.upgrades).map((c) => [c.modName, c.tier]);
};

describe('the upgrade candidates of a downloaded file', () => {
  it.each<[string, Mod[], DownloadedFile, unknown[]]>([
    ['are none when the downloaded file carries no mod id',
      [mod({ name: 'Harder VATS', nexusId: '111' })], downloadedFile({}), []],
    ['are none when no installed mod carries the downloaded file\'s mod id',
      [mod({ name: 'Harder VATS', nexusId: '111' })], downloadedFile({ modID: '222' }), []],
    ['are none when no mod id is present, even for a mod with no nexus id of its own',
      [mod({ name: 'A Local Mod' })], downloadedFile({}), []],
    ['flag an installed-file key match as tier fileId',
      [mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFileKeys: ['key-999'] })],
      downloadedFile({ modID: '111', installedKey: 'key-999' }), [['Harder VATS', 'fileId']]],
    ['take no fileId tier from a key of another mod\'s file, which shares only the file id',
      [mod({ name: 'Harder VATS', nexusId: '111', version: '2.0', installedFileKeys: ['other-mod-999'] })],
      downloadedFile({ modID: '111', installedKey: 'this-mod-999' }), [['Harder VATS', undefined]]],
    ['list a mod sharing only the mod id as unmarked, still a candidate',
      [mod({ name: 'Harder VATS A', nexusId: '111', version: '1.0' })],
      downloadedFile({ modID: '111', installedKey: 'key-999' }), [['Harder VATS A', undefined]]],
    ['sort a file-id match first, unmarked mods after',
      [mod({ name: 'No Match', nexusId: '111', version: '1.0' }), mod({ name: 'The Match', nexusId: '111', version: '2.0', installedFileKeys: ['key-999'] })],
      downloadedFile({ modID: '111', installedKey: 'key-999' }), [['The Match', 'fileId'], ['No Match', undefined]]],
    ['flag a meta.ini installationFileName match naming this exact downloaded file as tier installationFileName',
      [mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', installationFileName: 'harder-vats-v1.7z' })],
      downloadedFile({ modID: '111', name: 'harder-vats-v1.7z' }), [['Harder VATS', 'installationFileName']]],
    ['compare the installationFileName match case-folded, as the status does',
      [mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', installationFileName: 'Harder-VATS-v1.7Z' })],
      downloadedFile({ modID: '111', name: 'harder-vats-v1.7z' }), [['Harder VATS', 'installationFileName']]],
    ['leave out a mod installed from this file that does not share the mod id',
      [mod({ name: 'Hand Installed', installationFileName: 'foo.7z' }), mod({ name: 'Other Id', nexusId: '222', installationFileName: 'foo.7z' })],
      downloadedFile({ modID: '111', name: 'foo.7z' }), []],
    ['drop the installationFileName tier, listing the mod unmarked, when a fileId match exists elsewhere in the pool',
      [mod({ name: 'By Name', nexusId: '111', version: '1.0', installationFileName: 'foo.7z' }), mod({ name: 'By File Id', nexusId: '111', version: '2.0', installedFileKeys: ['key-999'] })],
      downloadedFile({ modID: '111', installedKey: 'key-999', name: 'foo.7z' }), [['By File Id', 'fileId'], ['By Name', undefined]]],
    ['take no fileId tier from a matching installationFileName whose key the mod\'s installed files lack, and still flag installationFileName',
      [mod({ name: 'Harder VATS', nexusId: '111', version: '1.0', installationFileName: 'harder-vats-v1.7z' })],
      downloadedFile({ modID: '111', installedKey: 'key-999', name: 'harder-vats-v1.7z' }), [['Harder VATS', 'installationFileName']]],
  ])('%s', (_case, mods, file, expected) => {
    expect(offered(mods, file)).toEqual(expected);
  });
});
