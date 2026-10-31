import { setIniValue } from '../codecs/qSettingsIni';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectKind } from '../../../test/expectKind';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { managerOver } from '../../../test/mo2/adapterOver';

let root: string;

afterEach(() => rm(root, { recursive: true, force: true }));

describe('the MO2 adapter\'s installation file', () => {
  it('says why a file this machine holds cannot be read', async () => {
    root = await mkdtemp(join(tmpdir(), 'modbench-mo2-installation-'));
    await mkdir(join(root, 'mods', 'Mod'), { recursive: true });
    await mkdir(join(root, 'downloads', 'PkgA-1-0.zip'), { recursive: true });
    await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout 4\r\n[Settings]\r\n');
    await writeFile(join(root, 'mods', 'Mod', 'meta.ini'), setIniValue('[General]\r\n', 'General', 'installationFile', 'PkgA-1-0.zip'));

    expect(expectKind(await managerOver(root).installationFile('Mod'), 'unreadable').reason).toMatch(/^Modbench cannot tell what PkgA-1-0\.zip installs: /);
  });
});
