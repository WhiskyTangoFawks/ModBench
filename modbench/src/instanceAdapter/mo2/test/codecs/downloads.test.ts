import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import { expectKind } from '../../../../test/expectKind';
import type { DownloadedFileMark } from '../../../instanceAdapter';
import type { NexusFileInfo } from '../../../../ports/nexusFileInfo';
import { mo2InstanceHolding, type HeldInstance } from '../../../test/mo2InstanceHolding';

vi.mock('vscode', () => fakeVscodeModule());

const NAME = 'Release.7z';
const META = `downloads/${NAME}.meta`;

const holding = (meta?: string): HeldInstance =>
  mo2InstanceHolding({ [`downloads/${NAME}`]: 'bytes', ...meta === undefined ? {} : { [META]: meta } });

async function listed(meta: string) {
  const { downloadedFiles } = await holding(meta).adapter.reading();
  return expectKind(downloadedFiles, 'listed').files?.[0];
}

const metaOf = async (meta: string) => (await listed(meta))?.meta;

async function marked(meta: string | undefined, mark: DownloadedFileMark): Promise<string> {
  const instance = holding(meta);
  await instance.adapter.markDownloadedFile(NAME, mark);
  return instance.text(META);
}

async function written(meta: string | undefined, info: NexusFileInfo): Promise<string> {
  const instance = holding(meta);
  await instance.adapter.writeNexusFileInfo(NAME, info);
  return instance.text(META);
}

describe('a downloaded file\'s status read from its .meta', () => {
  it('uninstalled=true -> Uninstalled status', async () => {
    expect((await metaOf('[General]\r\nuninstalled=true\r\n'))?.status).toBe('Uninstalled');
  });

  it('reads the tooltip fields: modName, gameName, author', async () => {
    expect(await metaOf('[General]\r\nmodName=Sleep or Save\r\ngameName=Fallout4\r\nauthor=SomeAuthor\r\n'))
      .toMatchObject({ modName: 'Sleep or Save', gameName: 'Fallout4', author: 'SomeAuthor' });
  });

  it('reads the direct URL a file was downloaded from, and none when the metadata names none', async () => {
    expect([(await metaOf('[General]\r\ndirectURL=https://f4se.silverlock.org/beta/f4se_0_06_23.7z\r\n'))?.directURL, (await metaOf('[General]\r\n'))?.directURL])
      .toEqual(['https://f4se.silverlock.org/beta/f4se_0_06_23.7z', undefined]);
  });

  it('treats modID=0 as no id, same as an absent modID (Visit-on-Nexus gated off)', async () => {
    expect((await metaOf('[General]\r\nmodID=0\r\n'))?.modID).toBeUndefined();
  });

  it.each([
    ['fileCategory=3', 3], ['fileCategory= 12 ', 12], ['fileCategory=-5', -5], ['fileCategory=+7', 7],
    ['fileCategory=2147483647', 2147483647], ['fileCategory=-2147483648', -2147483648], ['fileCategory=2147483648', 0],
    ['fileCategory=0x10', 0], ['fileCategory=1e2', 0], ['fileCategory=1.5', 0], ['fileCategory=abc', 0], ['fileCategory=', 0], ['', undefined],
  ])('reads the file category of %j as %s', async (line, expected) => {
    expect((await metaOf(`[General]\r\n${line}\r\n`))?.fileCategory).toBe(expected);
  });

  it('keys the installed file by its mod and file ids, and by nothing when either is absent', async () => {
    expect([(await metaOf('[General]\r\nmodID=9\r\nfileID=78\r\n'))?.installedKey, (await metaOf('[General]\r\nmodID=9\r\n'))?.installedKey])
      .toEqual(['9:78', undefined]);
  });

  it('reads the file ID, and reads 0 as none', async () => {
    expect([(await metaOf('[General]\r\nfileID=78\r\n'))?.fileID, (await metaOf('[General]\r\nfileID=0\r\n'))?.fileID]).toEqual(['78', undefined]);
  });

  it('treats fileID=0 as no id, same as an absent fileID', async () => {
    expect((await metaOf('[General]\r\nmodID=9\r\nfileID=0\r\n'))?.installedKey).toBeUndefined();
  });

  it('parses a hand-edited .meta with padded key=value spacing, which a writer never would, the same as the tight form', async () => {
    const tight = await metaOf('[General]\r\nmodID=12345\r\n');
    const padded = await metaOf('[General]\r\nmodID = 12345\r\n');
    expect(padded?.modID).toBe('12345');
    expect(padded).toEqual(tight);
  });
});

describe('whether a downloaded file\'s .meta hides it', () => {
  it('is false when removed is explicitly false', async () => {
    expect((await listed('[General]\r\nremoved=false\r\n'))?.excluded).toBe(false);
  });

  it('is independent of the Uninstalled Status: both keys coexist', async () => {
    const file = await listed('[General]\r\nuninstalled=true\r\nremoved=true\r\n');
    expect([file?.meta?.status, file?.excluded]).toEqual(['Uninstalled', true]);
  });
});

describe('the values a downloaded file\'s .meta holds', () => {
  it('are decoded, as MO2 writes a name holding a comma quoted', async () => {
    expect((await metaOf('[General]\r\nmodName="A, B"\r\n'))?.modName).toBe('A, B');
  });
});

describe('a downloaded file hidden or shown in its .meta', () => {
  it('creates a fresh [General] section with removed=true when there is no .meta text', async () => {
    expect(await marked(undefined, 'Excluded')).toBe('[General]\r\nremoved=true\r\n');
  });

  it('flips removed=true to false in place when unhiding as MO2 does, writing removed=false rather than deleting the key, byte-faithful', async () => {
    expect(await marked('[General]\r\ngameName=Fallout4\r\nremoved=true\r\nmodid=12345\r\n', 'Included'))
      .toBe('[General]\r\ngameName=Fallout4\r\nremoved=false\r\nmodid=12345\r\n');
  });
});

describe('a downloaded file marked installed in its .meta', () => {
  it('creates a fresh [General] section with both keys when there is no .meta text', async () => {
    expect(await marked(undefined, 'Installed')).toBe('[General]\r\ninstalled=true\r\nuninstalled=false\r\n');
  });

  it('clears an earlier uninstall, so a reinstalled downloaded file reads Installed again, MO2\'s markInstalled writing uninstalled=false beside installed=true and a reader taking uninstalled first', async () => {
    const { adapter } = holding('[General]\r\ninstalled=true\r\n');
    const status = async () => expectKind((await adapter.reading()).downloadedFiles, 'listed').files?.[0]?.meta?.status;

    await adapter.markDownloadedFile(NAME, 'Uninstalled');
    const uninstalled = await status();
    await adapter.markDownloadedFile(NAME, 'Installed');

    expect([uninstalled, await status()]).toEqual(['Uninstalled', 'Installed']);
  });
});

describe('a downloaded file marked uninstalled in its .meta', () => {
  it('leaves installed=true in place — it is a separate key, never cleared, as MO2 writes uninstalled=true on uninstall without clearing installed', async () => {
    expect(await marked('[General]\r\ninstalled=true\r\nmodid=12345\r\n', 'Uninstalled'))
      .toBe('[General]\r\nuninstalled=true\r\ninstalled=true\r\nmodid=12345\r\n');
  });
});

describe('the Nexus file info written to a downloaded file\'s .meta', () => {
  const info = {
    game: 'fallout4', modID: '4598', fileID: '78', name: 'Main', version: '2.1.5', fileCategory: 1, modName: 'Patch', category: 12,
    author: 'Team', uploader: 'Uploader', uploaderUrl: 'https://nexus/users/1', description: '[b]Fixes[/b]',
  };

  it('writes the keys in the order MO2 writes them, the description as HTML and the version canonical', async () => {
    expect(await written(undefined, info)).toBe([
      '[General]', 'gameName=Fallout4', 'modID=4598', 'fileID=78', 'name=Main', 'description=<b>Fixes</b>', 'modName=Patch',
      'version=2.1.5.0', 'fileCategory=1', 'category=12', 'author=Team', 'uploader=Uploader', 'uploaderUrl=https://nexus/users/1', '',
    ].join('\r\n'));
  });

  it.each([
    ['the newest version the metadata records', '[General]\r\nnewestVersion=2.0\r\n', 'version=2.0.0.0'],
    ['zero when the metadata records none', undefined, 'version=0.0.0.0'],
  ])('writes %s for a file with no version of its own when the list stands for it', async (_name, meta, expected) => {
    expect(await written(meta, { game: 'fallout4', modID: '1', versionFromNewest: true, modVersion: '9.9' })).toContain(expected);
  });
});
