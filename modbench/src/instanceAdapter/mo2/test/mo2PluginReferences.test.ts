import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { ManagerAdapter } from '../../publisher';
import { heldTexts } from '../../../symbolNames/symbolNames';
import { managerOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';

const PATCH = { name: 'Patch Mod.esp', origin: 'Patch Mod' };

describe('the MO2 Instance adapter saying where its files name a plugin (ADR-0028)', () => {
  let root: string;
  let adapter: ManagerAdapter;

  async function put(relative: string, contents: string): Promise<void> {
    await mkdir(join(root, relative, '..'), { recursive: true });
    await writeFile(join(root, relative), contents);
  }

  const read = () => adapter.pluginReferences.read(PATCH, heldTexts([]));
  const PLUGINS_TXT = '*Base.esm\r\n*Patch Mod.esp\r\n';

  beforeEach(async () => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
    await put('profiles/Default/plugins.txt', PLUGINS_TXT);
    await put('profiles/Default/loadorder.txt', 'Base.esm\r\nPatch Mod.esp\r\n');
    await put('profiles/Secondary/plugins.txt', '*Base.esm\r\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names it, by its file name alone, on each line of every profile\'s plugin order that names it', async () => {
    const { references, leftOut } = await read();

    expect(leftOut).toEqual([]);
    expect(references).toEqual([
      { place: { file: join(root, 'profiles/Default/loadorder.txt'), start: { line: 1, character: 0 }, end: { line: 1, character: 13 } }, names: { name: 'Patch Mod.esp' } },
      { place: { file: join(root, 'profiles/Default/plugins.txt'), start: { line: 1, character: 1 }, end: { line: 1, character: 14 } }, names: { name: 'Patch Mod.esp' } },
    ]);
  });

  it('says which plugin a line of a plugin order or a sorting rule file names at a place, and none in another file', async () => {
    const userlist = 'plugins:\n  - name: Other.esp\n    after: [ \'Patch Mod.esp\' ]\n';
    const at = (text: string, name: string) => text.indexOf(name) + 2;

    expect(await adapter.pluginReferences.nameAt(join(root, 'profiles/Default/plugins.txt'), PLUGINS_TXT, at(PLUGINS_TXT, 'Patch'))).toEqual({ name: 'Patch Mod.esp' });
    expect(await adapter.pluginReferences.nameAt(join(root, 'userlist.yaml'), userlist, at(userlist, 'Other'))).toEqual({ name: 'Other.esp' });
    expect(await adapter.pluginReferences.nameAt(join(root, 'notes.txt'), PLUGINS_TXT, at(PLUGINS_TXT, 'Patch'))).toBeUndefined();
  });

  it('names it in the sorting rule files, and leaves out one that does not read, saying why', async () => {
    await put('userlist.yaml', 'plugins:\n  - name: Other.esp\n    after: [ \'Patch Mod.esp\' ]\n');
    await put('masterlist.yaml', 'plugins: [');

    const { references, leftOut } = await read();

    expect(references).toContainEqual(
      { place: { file: join(root, 'userlist.yaml'), start: { line: 2, character: 14 }, end: { line: 2, character: 27 } }, names: { name: 'Patch Mod.esp' } });
    expect(leftOut).toEqual([expect.stringContaining(join(root, 'masterlist.yaml')) as unknown]);
  });
});
