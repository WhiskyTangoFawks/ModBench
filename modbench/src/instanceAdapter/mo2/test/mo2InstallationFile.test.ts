import { setIniValue } from '../codecs/qSettingsIni';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectKind } from '../../../test/expectKind';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

import { managerOver } from '../../../test/mo2/adapterOver';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';

let root: string;

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('the MO2 adapter\'s installation file', () => {
  it('says why a file this machine holds cannot be read', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-mo2-installation-'));
    await mkdir(join(root, 'mods', 'Mod'), { recursive: true });
    await mkdir(join(root, 'downloads', 'PkgA-1-0.zip'), { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout 4\r\n[Settings]\r\n');
    await writeFile(join(root, 'mods', 'Mod', 'meta.ini'), setIniValue('[General]\r\n', 'General', 'installationFile', 'PkgA-1-0.zip'));

    expect(expectKind(await managerOver(root).installationFile('Mod'), 'unreadable').reason).toMatch(/^Modbench cannot tell what PkgA-1-0\.zip installs: /);
  });

  it('reads the mod\'s metadata in the folder it is handed, listing no mods folder', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-mo2-installation-'));
    await mkdir(join(root, 'mods', 'Mod'), { recursive: true });
    await mkdir(join(root, 'downloads', 'PkgA-1-0.zip'), { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout 4\r\n[Settings]\r\n');
    await writeFile(join(root, 'mods', 'Mod', 'meta.ini'), setIniValue('[General]\r\n', 'General', 'installationFile', 'PkgA-1-0.zip'));
    vi.mocked(readdir).mockClear();

    expect(expectKind(await managerOver(root).installationFile('Mod', join(root, 'mods', 'Mod')), 'unreadable').reason).toMatch(/^Modbench cannot tell what PkgA-1-0\.zip installs: /);
    expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === join(root, 'mods'))).toEqual([]);
  });

  it('parses a downloaded file\'s metadata once while its stamp has not changed', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-mo2-installation-'));
    const downloads = join(root, 'downloads');
    await mkdir(downloads, { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout 4\r\n[Settings]\r\n');
    await writeFile(join(downloads, 'Pkg.zip'), 'bytes');
    await writeFile(join(downloads, 'Pkg.zip.meta'), '[General]\r\nmodID=4598\r\nversion=1.0\r\n');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
    const adapter = managerOver(root, { installationFileReader: fakeInstallationFileReader([]) });
    await adapter.downloadedFile('Pkg.zip');
    vi.mocked(readFile).mockClear();

    await adapter.downloadedFile('Pkg.zip');

    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === join(downloads, 'Pkg.zip.meta'))).toEqual([]);
  });
});
