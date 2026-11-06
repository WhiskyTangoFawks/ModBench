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
const KEYWORDS = '[submodule "sub"]\n\tpath = mods/sub\n[submodule "libs"]\n\tpath = libs/x\n';
const mod = (name: string): EntrySymbol => ({ kind: 'mod', name });
const separator = (name: string): EntrySymbol => ({ kind: 'separator', name });
const downloadedFile = (name: string): EntrySymbol => ({ kind: 'downloadedFile', name });
const profile = (name: string): EntrySymbol => ({ kind: 'profile', name });
const PATCH_META = '[General]\r\nversion=1\r\ninstallationFile=D:/Downloads/Patch-1.7z\r\n';
const HARDER_META = '[General]\ninstallationFile=patch-1.7z\n';

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

  it('places every entry the active profile\'s mod list holds at its line, from that one list, and the unsaved text in its place', async () => {
    const places = (await adapter.entryReferences.listed(heldTexts([]))).map(({ entry, place }) => [entry, place.file, place.start.line]);

    expect(places).toEqual([
      [mod('Patch Mod'), join(root, 'profiles/Default/modlist.txt'), 1], [mod('Base Mod'), join(root, 'profiles/Default/modlist.txt'), 2],
      [separator('Patch Mod'), join(root, 'profiles/Default/modlist.txt'), 3],
    ]);
    const unsaved = heldTexts([[join(root, 'profiles/Default/modlist.txt'), '+Held Mod\r\n']]);
    expect((await adapter.entryReferences.listed(unsaved)).map(({ entry }) => entry)).toEqual([mod('Held Mod')]);
  });

  describe('a downloaded file and a profile', () => {
    beforeEach(async () => {
      await put('mods/Patch Mod/meta.ini', PATCH_META);
      await put('mods/Harder VATS/meta.ini', HARDER_META);
    });

    it('names a downloaded file, whatever its case, at the file name each mod\'s meta.ini installed it from, below any folder the value holds', async () => {
      const { references, leftOut } = await adapter.entryReferences.read(downloadedFile('Patch-1.7z'), heldTexts([]));

      expect(leftOut).toEqual([]);
      expect(references).toEqual(expect.arrayContaining([at('mods/Patch Mod/meta.ini', 2, 30, 40), at('mods/Harder VATS/meta.ini', 1, 17, 27)]));
      expect(references).toHaveLength(2);
    });

    it('names a profile at the profile ModOrganizer.ini selects, inside the byte array MO2 writes it as', async () => {
      expect((await adapter.entryReferences.read(profile('default'), heldTexts([]))).references).toEqual([at('ModOrganizer.ini', 2, 28, 35)]);
      expect((await adapter.entryReferences.read(profile('Secondary'), heldTexts([]))).references).toEqual([]);
    });

    it.each([
      ['a downloaded file at the file name of installationFile', 'mods/Patch Mod/meta.ini', PATCH_META, PATCH_META.indexOf('Patch-1') + 2,
        { entry: downloadedFile('Patch-1.7z'), start: PATCH_META.indexOf('Patch-1'), end: PATCH_META.indexOf('Patch-1') + 10 }],
      ['no downloaded file at the folder installationFile holds it in', 'mods/Patch Mod/meta.ini', PATCH_META, PATCH_META.indexOf('Downloads'), undefined],
      ['no downloaded file at another key of meta.ini', 'mods/Patch Mod/meta.ini', PATCH_META, PATCH_META.indexOf('version') + 1, undefined],
      ['the profile ModOrganizer.ini selects', 'ModOrganizer.ini', '[General]\nselected_profile=@ByteArray(Default)\n', 39,
        { entry: profile('Default'), start: 38, end: 45 }],
      ['a profile whose name MO2 writes escaped, over its escaped bytes alone and never the byte array around them', 'ModOrganizer.ini',
        '[General]\nselected_profile=@ByteArray(\\xc3\\x91o\\xc3\\xb1o)\n', 40, { entry: profile('Ñoño'), start: 38, end: 56 }],
    ])('says what a file names at a place: %s', async (_case, file, text, offset, expected) => {
      expect(await adapter.entryReferences.nameAt(join(root, file), text, offset)).toEqual(expected);
    });
  });

  it('names a mod in the repository\'s ignore list at the line that holds its folder whole or lets its source folder in, and in .gitmodules at its entry and path', async () => {
    await put('.gitignore', IGNORE);
    await put('.gitmodules', GITMODULES);

    const { references } = await adapter.entryReferences.read(mod('Patch Mod'), heldTexts([]));

    expect(references).toEqual([
      at('profiles/Default/modlist.txt', 1, 1, 10), at('profiles/Secondary/modlist.txt', 0, 1, 10),
      at('.gitignore', 1, 7, 16), at('.gitignore', 4, 9, 18), at('.gitignore', 5, 9, 18),
      at('.gitmodules', 0, 12, 21), at('.gitmodules', 1, 15, 24),
    ]);
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

  it('names a name that is a keyword of .gitmodules at its quoted span, and no section whose path is outside mods/ and source/', async () => {
    await put('.gitmodules', KEYWORDS);

    expect((await adapter.entryReferences.read(mod('sub'), heldTexts([]))).references.filter(({ file }) => file.endsWith('.gitmodules')))
      .toEqual([at('.gitmodules', 0, 12, 15), at('.gitmodules', 1, 13, 16)]);
    expect((await adapter.entryReferences.read(mod('libs'), heldTexts([]))).references).toEqual([]);
  });

  it('reads an unsaved file in place of the one on disk', async () => {
    const unsaved = join(root, 'profiles/Secondary/modlist.txt');

    const { references } = await adapter.entryReferences.read(mod('Base Mod'), heldTexts([[unsaved, '+Base Mod\r\n']]));

    expect(references.map(({ file }) => file)).toEqual([join(root, 'profiles/Default/modlist.txt'), unsaved]);
  });

  const spelling = (text: string, spelled: string, entry: EntrySymbol, from = 0) =>
    ({ entry, start: text.indexOf(spelled, from), end: text.indexOf(spelled, from) + spelled.length });
  const inside = (text: string, needle: string): number => text.indexOf(needle) + 2;

  it.each([
    ['a mod on its line of a mod list', 'profiles/Default/modlist.txt', MODLIST, inside(MODLIST, 'Base'), spelling(MODLIST, 'Base Mod', mod('Base Mod'))],
    ['a separator on its line, over its name', 'profiles/Default/modlist.txt', MODLIST, inside(MODLIST, 'Patch Mod_sep'), spelling(MODLIST, 'Patch Mod', separator('Patch Mod'), MODLIST.indexOf('Patch Mod_sep'))],
    ['a mod at the line of the ignore list that holds its folder', '.gitignore', IGNORE, inside(IGNORE, 'Patch Mod/*'), spelling(IGNORE, 'Patch Mod', mod('Patch Mod'))],
    ['a mod at a name the ignore list escapes, over the name as written', '.gitignore', IGNORE, inside(IGNORE, 'Patch\\*Mod'), spelling(IGNORE, 'Patch\\*Mod', mod('Patch*Mod'))],
    ['a mod at a section of .gitmodules', '.gitmodules', GITMODULES, inside(GITMODULES, '"Other"'), spelling(GITMODULES, 'Other', mod('Other'))],
    ['a mod whose name is a keyword at its quoted name', '.gitmodules', KEYWORDS, KEYWORDS.indexOf('"sub"') + 2, spelling(KEYWORDS, 'sub', mod('sub'), KEYWORDS.indexOf('"sub"'))],
    ['no entry in a comment of a mod list', 'profiles/Default/modlist.txt', MODLIST, inside(MODLIST, 'comment'), undefined],
    ['no entry in a section whose path is outside mods/ and source/', '.gitmodules', KEYWORDS, KEYWORDS.indexOf('"libs"') + 2, undefined],
    ['no entry in a file the adapter names none of', 'notes.txt', MODLIST, inside(MODLIST, 'Base'), undefined],
  ])('says which entry a file names at a place, and the span that names it: %s', async (_case, file, text, offset, expected) => {
    await put('.gitignore', IGNORE);
    await put('.gitmodules', file === '.gitmodules' ? text : GITMODULES);

    expect(await adapter.entryReferences.nameAt(join(root, file), text, offset)).toEqual(expected);
  });
});
