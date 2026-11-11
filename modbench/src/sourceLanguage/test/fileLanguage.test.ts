import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const { setInput, TEXT } = vi.hoisted(() => ({ setInput: vi.fn(), TEXT: '{ "FormKey": "000801:Mod.esp", "Diffuse": "Decals\\\\Stain_d.dds", "EditorID": "Stain" }' }));
vi.mock('vscode', () => ({
  Uri, TreeItem, TreeItemCollapsibleState,
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
  workspace: { openTextDocument: () => Promise.resolve({ getText: () => TEXT, positionAt: (offset: number) => offset }) },
}));

import { fileLanguage, type FileClient } from '../fileLanguage';
import { recordingReporter } from '../../test/surfacingDoubles';
import { comparisonOf, fieldOf } from '../../test/comparison';
import type { CopyAt } from '../../instanceLoader/fileConflictIndex';

const HOLDER = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/TextureSet.json';
const NAMED = TEXT.indexOf('Decals');
const FILE = 'textures/decals/stain_d.dds';
const UNREAD = '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx';

const diffuse = fieldOf({ name: 'Diffuse', type: 'string', isAssetLink: true });
const editorId = fieldOf({ name: 'EditorID', type: 'string' });
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };

function language(answer: Awaited<ReturnType<FileClient['getFileReferences']>>, copy: CopyAt | null = LOOSE) {
  const reporter = recordingReporter();
  const getFileReferences = vi.fn(() => Promise.resolve(answer));
  const resolveFilePath = vi.fn(() => Promise.resolve(FILE));
  const reveal = vi.fn(() => Promise.resolve());
  const client: FileClient = {
    getFileReferences,
    resolveFilePath,
    getComparison: () => Promise.resolve(comparisonOf(HOLDER, [{ plugin: 'Mod.esp', isWinner: true, fields: [diffuse, editorId] }])),
    getRecordOwner: () => Promise.resolve(undefined),
    getCopyDocument: () => Promise.resolve({ kind: 'OwnFile' as const, location: SOURCE }),
  };
  const copyOf = vi.fn((path: string) => path === FILE ? copy ?? undefined : undefined);
  return { reporter, getFileReferences, resolveFilePath, reveal, ...fileLanguage({ reporter, client, gameRelease: () => Promise.resolve('Fallout4'), copyOf, reveal }) };
}

describe('referenced by on a file (commands.md, `referenced by` under Mod, a file as its Argument)', () => {
  beforeEach(() => { setInput.mockClear(); });

  it('lists the records that name its path in the Data folder, at the member that names it, and notifies of a record it could not read', async () => {
    const { referencedBy, reporter, getFileReferences } = language({
      copies: [{ formKey: HOLDER, plugin: { name: 'Mod.esp', origin: 'Mod' }, inPluginSource: true, fieldPaths: ['Diffuse'] }], unread: [UNREAD],
    });

    await referencedBy(FILE);

    expect(getFileReferences.mock.calls).toEqual([[FILE]]);
    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({
      title: `Referenced By: ${FILE}`, location: { uri: Uri.file(SOURCE), range: { start: NAMED, end: NAMED + 'Decals\\\\Stain_d.dds'.length } },
    }));
    expect(reporter.reports.map(({ severity, detail }) => [severity, detail])).toEqual([['warning', UNREAD]]);
  });

  it('says that no record names the file, which leaves the view where it was', async () => {
    const { referencedBy, reporter } = language({ copies: [], unread: [] });

    await referencedBy(FILE);

    expect([setInput.mock.calls, reporter.reports.map(({ severity }) => severity)]).toEqual([[], ['error']]);
  });
});

describe('Go to Definition on a path in plugin source (symbols.md, The symbols, File)', () => {
  const NONE = { copies: [], unread: [] };
  const document = (path = SOURCE) => ({ uri: Uri.file(path), getText: () => TEXT });
  const SPAN = { start: NAMED, end: NAMED + 'Decals\\\\Stain_d.dds'.length };

  it('shows the copy the game gets in the Explorer, asking mEdit which file the record\'s path names', async () => {
    const { definitionAt, reveal, resolveFilePath } = language(NONE);

    expect(await definitionAt(document(), NAMED + 2)).toEqual({ ...SPAN, resolved: true });
    expect([resolveFilePath.mock.calls, reveal.mock.calls]).toEqual([[['Fallout4', 'weap', 'Diffuse', 'Decals\\Stain_d.dds']], [[LOOSE]]]);
  });

  it('shows a copy in an archive as it is, for the archive file system to read', async () => {
    const archived: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/instance/mods/Mod/Mod - Textures.ba2', file: FILE };
    const { definitionAt, reveal } = language(NONE, archived);

    await definitionAt(document(), NAMED + 2);

    expect(reveal.mock.calls).toEqual([[archived]]);
  });

  it('says that no mod or Data folder holds a path no copy exists for, and leaves the editor where it is', async () => {
    const { definitionAt, reveal, reporter } = language(NONE, null);

    expect(await definitionAt(document(), NAMED + 2)).toEqual({ ...SPAN, resolved: false });
    expect([reveal.mock.calls, reporter.shownFailures]).toEqual([[], [{
      severity: 'warning', message: `Go to Definition cannot go to ${FILE}.`, detail: `No enabled mod, Overwrite or the Data folder holds ${FILE}.`,
    }]]);
  });

  it.each([
    ['a field that is no path', TEXT.lastIndexOf('Stain') + 2, SOURCE],
    ['a path in a file that is no plugin source', NAMED + 2, '/instance/notes.json'],
  ])('is not %s', async (_case, offset, file) => {
    const { definitionAt, resolveFilePath } = language(NONE);

    expect(await definitionAt(document(file), offset)).toBeUndefined();
    expect(resolveFilePath).not.toHaveBeenCalled();
  });
});
