import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import type { ManagerAdapter } from '../../publisher';
import { heldTexts, type EntrySymbol } from '../../../symbolNames/symbolNames';
import { managerOver } from '../../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../../test/mo2/corpusFixture';

const MODLIST = '# comment\r\n+Patch Mod\r\n-Base Mod\r\n+Patch Mod_separator\r\n';
const IGNORE = '# Mod folders this repository holds whole\n!/mods/Patch Mod/*\n!/mods/Patch\\*Mod/*\n# End of mod folders this repository holds whole\n!/source/Patch Mod\n!/source/Patch Mod/\n!/mods/Patch Mod_separator/*\n';
const GITMODULES = '[submodule "Patch Mod"]\n\tpath = source/Patch Mod\n\turl = https://example.test/a.git\n[submodule "Other"]\n\tpath = source/Other\n';
const mod = (name: string): EntrySymbol => ({ kind: 'mod', name });
const separator = (name: string): EntrySymbol => ({ kind: 'separator', name });

describe('the MO2 Instance adapter saying where its files name a mod or a separator (ADR-0028)', () => {
  let root: string;
  let adapter: ManagerAdapter;

  async function put(relative: string, contents: string): Promise<void> {
    await mkdir(join(root, relative, '..'), { recursive: true });
    await writeFile(join(root, relative), contents);
  }
  const at = (file: string, line: number, start: number, end: number) => ({ file: join(root, file), start: { line, character: start }, end: { line, character: end } });

  beforeEach(async () => {
    root = cloneCorpusFixture();
    adapter = managerOver(root);
    await put('profiles/Default/modlist.txt', MODLIST);
    await put('profiles/Secondary/modlist.txt', '-patch mod\r\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('names a mod, whatever its case and state, on the line of every profile\'s mod list that lists it, and no separator of that name', async () => {
    const { references, leftOut } = await adapter.entryReferences.read(mod('Patch Mod'), heldTexts([]));

    expect(leftOut).toEqual([]);
    expect(references).toEqual([at('profiles/Default/modlist.txt', 1, 1, 10), at('profiles/Secondary/modlist.txt', 0, 1, 10)]);
  });

  it('names a separator on its line, over its name without the suffix MO2 adds', async () => {
    const { references } = await adapter.entryReferences.read(separator('Patch Mod'), heldTexts([]));

    expect(references).toEqual([at('profiles/Default/modlist.txt', 3, 1, 10)]);
  });

  it('names a mod in the repository\'s ignore list at the line that holds its folder whole or lets its source folder in, and in .gitmodules at its entry and path', async () => {
    await put('.gitignore', IGNORE);
    await put('.gitmodules', GITMODULES);

    const { references } = await adapter.entryReferences.read(mod('Patch Mod'), heldTexts([]));

    expect(references).toEqual(expect.arrayContaining([
      at('.gitignore', 1, 7, 16), at('.gitignore', 4, 9, 18), at('.gitignore', 5, 9, 18),
      at('.gitmodules', 0, 12, 21), at('.gitmodules', 1, 15, 24),
    ]));
    expect(references).toHaveLength(7);
  });

  it('spans a name the ignore list escapes as the line writes it', async () => {
    await put('.gitignore', IGNORE);

    const { references } = await adapter.entryReferences.read(mod('Patch*Mod'), heldTexts([]));

    expect(references).toEqual([at('.gitignore', 2, 7, 17)]);
  });

  it('names a separator\'s folder in the ignore list', async () => {
    await put('.gitignore', IGNORE);

    const { references } = await adapter.entryReferences.read(separator('Patch Mod'), heldTexts([]));

    expect(references).toContainEqual(at('.gitignore', 6, 7, 16));
  });

  it('places every entry the active profile\'s mod list holds at its line, from that one list, and the unsaved text in its place', async () => {
    const places = (await adapter.entryReferences.listed(heldTexts([]))).map(({ entry, place }) => [entry, place.file, place.start.line]);

    expect(places).toEqual([
      [mod('Patch Mod'), join(root, 'profiles/Default/modlist.txt'), 1], [mod('Base Mod'), join(root, 'profiles/Default/modlist.txt'), 2],
      [separator('Patch Mod'), join(root, 'profiles/Default/modlist.txt'), 3],
    ]);
    const unsaved = heldTexts([[join(root, 'profiles/Default/modlist.txt'), '+Held Mod\r\n']]);
    expect((await adapter.entryReferences.listed(unsaved)).map(({ entry }) => entry)).toEqual([mod('Held Mod')]);
  });

  it('reads an unsaved file in place of the one on disk', async () => {
    const unsaved = join(root, 'profiles/Secondary/modlist.txt');

    const { references } = await adapter.entryReferences.read(mod('Base Mod'), heldTexts([[unsaved, '+Base Mod\r\n']]));

    expect(references.map(({ file }) => file)).toEqual([join(root, 'profiles/Default/modlist.txt'), unsaved]);
  });

  it('says which entry a line of a mod list, the ignore list or .gitmodules names at a place, and none in a comment or another file', async () => {
    const list = join(root, 'profiles/Default/modlist.txt');
    const inText = (text: string, name: string) => text.indexOf(name) + 2;
    await put('.gitignore', IGNORE);
    await put('.gitmodules', GITMODULES);

    expect(await adapter.entryReferences.nameAt(list, MODLIST, inText(MODLIST, 'Base'))).toEqual(mod('Base Mod'));
    expect(await adapter.entryReferences.nameAt(list, MODLIST, inText(MODLIST, 'Patch Mod_sep'))).toEqual(separator('Patch Mod'));
    expect(await adapter.entryReferences.nameAt(join(root, '.gitignore'), IGNORE, inText(IGNORE, 'Patch Mod/*'))).toEqual(mod('Patch Mod'));
    expect(await adapter.entryReferences.nameAt(join(root, '.gitmodules'), GITMODULES, inText(GITMODULES, 'Other'))).toEqual(mod('Other'));
    expect(await adapter.entryReferences.nameAt(list, MODLIST, inText(MODLIST, 'comment'))).toBeUndefined();
    expect(await adapter.entryReferences.nameAt(join(root, 'notes.txt'), MODLIST, inText(MODLIST, 'Base'))).toBeUndefined();
  });
});
