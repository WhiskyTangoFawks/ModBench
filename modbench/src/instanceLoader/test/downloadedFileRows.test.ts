import { describe, it, expect, afterEach } from 'vitest';
import type { DownloadedFile, DownloadedFileMeta, ModMeta } from '../../instanceAdapter/instanceAdapter';
import type { DownloadedFileRow, InstanceValue } from '../instance';
import { disposeLoaded, loader } from './loader';

afterEach(disposeLoaded);

const metaOf = (fields: Partial<DownloadedFileMeta> = {}): DownloadedFileMeta => ({ status: 'Downloaded', ...fields });

const file = (name: string, meta?: DownloadedFileMeta, excluded = false): DownloadedFile => ({
  name, path: `/downloads/${name}`, metadataPath: `/downloads/${name}.meta`, size: 123, mtimeMs: 100, excluded, meta,
});

async function rowsOf(files: DownloadedFile[], folderMeta: ReadonlyMap<string, ModMeta> = new Map()): Promise<readonly DownloadedFileRow[]> {
  const { instance } = loader({ downloadedFiles: { kind: 'listed', downloadsDir: '/downloads', files }, folderMeta });
  await instance.refresh();
  const { downloadedFiles }: InstanceValue = instance.value;
  return downloadedFiles.kind === 'listed' ? downloadedFiles.rows : [];
}

describe('the rows of the downloaded files', () => {
  it('are a Downloaded row carrying its two paths for a file with no metadata', async () => {
    expect(await rowsOf([file('foo.zip')])).toEqual([{
      name: 'foo.zip',
      displayName: 'foo.zip',
      status: 'Downloaded',
      size: 123,
      mtimeMs: 100,
      hasMeta: false,
      excluded: false,
      upgrades: [],
      path: '/downloads/foo.zip',
      metadataPath: '/downloads/foo.zip.meta',
    }]);
  });

  it('flag hasMeta and carry the metadata\'s fields', async () => {
    const meta = metaOf({ modID: '12345', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone' });

    expect(await rowsOf([file('foo.zip', meta)])).toMatchObject([{
      hasMeta: true, modID: '12345', version: '1.2.3', modName: 'Sleep', gameName: 'Fallout4', author: 'Someone',
    }]);
  });

  it('carry an excluded file as a row flagged excluded, filtering being a view\'s concern', async () => {
    expect(await rowsOf([file('foo.zip', undefined, true)])).toMatchObject([{ name: 'foo.zip', excluded: true }]);
  });

  it.each<[string, DownloadedFileMeta, string]>([
    ['the metadata\'s name when it has one', metaOf({ name: 'Sleep or Save' }), 'Sleep or Save'],
    ['the file name when the metadata\'s name is absent', metaOf(), 'foo_1_2_3.zip'],
    ['the file name when the metadata\'s name is empty', metaOf({ name: '' }), 'foo_1_2_3.zip'],
  ])('are labelled with %s', async (_case, meta, displayName) => {
    expect((await rowsOf([file('foo_1_2_3.zip', meta)])).map((row) => row.displayName)).toEqual([displayName]);
  });
});

describe('a downloaded file\'s Installed follows the mod folders that name it, not the metadata', () => {
  it.each<[string, DownloadedFileMeta, [string, ModMeta][], DownloadedFileRow['status']]>([
    ['Installed when a mod folder names it, whatever the metadata says', metaOf({ modID: '1' }), [['Textures', { installationFileName: 'Pack.7z' }]], 'Installed'],
    ['Installed when a mod folder names it in another case', metaOf(), [['Textures', { installationFileName: 'PACK.7Z' }]], 'Installed'],
    ['Installed when two mod folders name it, one in another case', metaOf(), [['Textures', { installationFileName: 'Pack.7z' }], ['Meshes', { installationFileName: 'pack.7z' }]], 'Installed'],
    ['Downloaded when the only mod folder names no installation file: unknown, never an uninstall', metaOf(), [['Hand Made', {}]], 'Downloaded'],
    ['Uninstalled, not Downloaded, when no mod folder names it though the metadata claims installed', metaOf({ status: 'Installed' }), [], 'Uninstalled'],
    ['Uninstalled when no mod folder names it and the metadata says so, a statement about the downloaded file', metaOf({ status: 'Uninstalled' }), [], 'Uninstalled'],
  ])('is %s', async (_case, meta, folderMeta, status) => {
    expect((await rowsOf([file('Pack.7z', meta)], new Map(folderMeta))).map((row) => row.status)).toEqual([status]);
  });
});
