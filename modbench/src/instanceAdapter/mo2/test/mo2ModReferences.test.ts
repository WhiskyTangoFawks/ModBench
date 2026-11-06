import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { ManagerAdapter } from '../../publisher';
import { heldTexts } from '../../../symbolNames/symbolNames';
import { managerOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';

const MODLIST = '# comment\r\n+Patch Mod\r\n-Base Mod\r\n+Patch Mod_separator\r\n';

describe('the MO2 Instance adapter saying where its files name a mod (ADR-0028)', () => {
  let root: string;
  let adapter: ManagerAdapter;

  async function put(relative: string, contents: string): Promise<void> {
    await mkdir(join(root, relative, '..'), { recursive: true });
    await writeFile(join(root, relative), contents);
  }

  beforeEach(async () => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
    await put('profiles/Default/modlist.txt', MODLIST);
    await put('profiles/Secondary/modlist.txt', '-patch mod\r\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names it, whatever its case and state, on the line of every profile\'s mod list that lists it, and no separator of that name', async () => {
    const { references, leftOut } = await adapter.modReferences.read('Patch Mod', heldTexts([]));

    expect(leftOut).toEqual([]);
    expect(references).toEqual([
      { file: join(root, 'profiles/Default/modlist.txt'), start: { line: 1, character: 1 }, end: { line: 1, character: 10 } },
      { file: join(root, 'profiles/Secondary/modlist.txt'), start: { line: 0, character: 1 }, end: { line: 0, character: 10 } },
    ]);
  });

  it('reads an unsaved mod list in place of the file', async () => {
    const unsaved = join(root, 'profiles/Secondary/modlist.txt');

    const { references } = await adapter.modReferences.read('Base Mod', heldTexts([[unsaved, '+Base Mod\r\n']]));

    expect(references.map(({ file }) => file)).toEqual([join(root, 'profiles/Default/modlist.txt'), unsaved]);
  });

  it('says which mod a line of a mod list names at a place, and none for a separator, a comment or another file', async () => {
    const file = join(root, 'profiles/Default/modlist.txt');
    const at = (name: string) => MODLIST.indexOf(name) + 2;

    expect(await adapter.modReferences.nameAt(file, MODLIST, at('Base'))).toBe('Base Mod');
    expect(await adapter.modReferences.nameAt(file, MODLIST, at('Patch Mod_sep'))).toBeUndefined();
    expect(await adapter.modReferences.nameAt(file, MODLIST, at('comment'))).toBeUndefined();
    expect(await adapter.modReferences.nameAt(join(root, 'notes.txt'), MODLIST, at('Base'))).toBeUndefined();
  });
});
