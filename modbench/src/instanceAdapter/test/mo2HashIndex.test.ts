import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../test/noDetectors';
import { fakeArchiveReader } from '../../test/fakeArchiveReader';

vi.mock('vscode', () => fakeVscodeModule());

import { mo2InstanceAdapter } from '../mo2Instance';

let root: string;

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('the MO2 adapter\'s hashes', () => {
  it('keeps its index in a folder of its own at the instance root', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
    root = await mkdtemp(join(tmpdir(), 'modbench-mo2-hashes-'));
    await mkdir(join(root, 'mods', 'Mod'), { recursive: true });
    await writeFile(join(root, 'Mod.7z'), 'aaaa');
    await writeFile(join(root, 'mods', 'Mod', 'meta.ini'), `[General]\r\ninstallationFile=${join(root, 'Mod.7z')}\r\n`);
    const adapter = mo2InstanceAdapter({
      instanceRoot: root, gameDirectoryOverrides: () => ({}), gameDirectoryChanged: () => ({ dispose: () => {} }), detectors: NO_DETECTORS,
      archives: fakeArchiveReader([]),
    });

    await adapter.installationFile('Mod');

    expect(await readdir(join(root, 'hash-index'))).toEqual(['hashes.jsonl']);
  });
});
