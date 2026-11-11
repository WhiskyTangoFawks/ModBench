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
import { localFailure } from '../../wire/readFailed';
import type { CopyAt } from '../../instanceLoader/fileConflictIndex';

const HOLDER = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/TextureSet.json';
const NAMED = TEXT.indexOf('Decals');
const FILE = 'textures/decals/stain_d.dds';
const UNREAD = '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx';

const diffuse = fieldOf({ name: 'Diffuse', type: 'string', isAssetLink: true });
const editorId = fieldOf({ name: 'EditorID', type: 'string' });
const LOOSE: CopyAt = { kind: 'loose', path: '/instance/mods/Mod/Textures/Decals/Stain_d.dds' };

const NO_COPY = { none: `No enabled mod, Overwrite or loose file in the Data folder holds ${FILE}.` };

interface Doubles {
  copy?: CopyAt | { none: string };
  resolve?: () => ReturnType<FileClient['resolveFilePath']>;
  compare?: FileClient['getComparison'];
  reveal?: () => Promise<void>;
}

function language(answer: Awaited<ReturnType<FileClient['getFileReferences']>>, { copy = LOOSE, resolve = () => Promise.resolve(FILE), compare, reveal: revealing = () => Promise.resolve() }: Doubles = {}) {
  const reporter = recordingReporter();
  const getFileReferences = vi.fn(() => Promise.resolve(answer));
  const resolveFilePath = vi.fn(resolve);
  const reveal = vi.fn(revealing);
  const client: FileClient = {
    getFileReferences,
    resolveFilePath,
    getComparison: compare ?? (() => Promise.resolve(comparisonOf(HOLDER, [{ plugin: 'Mod.esp', recordType: 'txst', isWinner: true, fields: [diffuse, editorId] }]))),
    getRecordOwner: () => Promise.resolve(undefined),
    getCopyDocument: () => Promise.resolve({ kind: 'OwnFile' as const, location: SOURCE }),
  };
  const copyOf = vi.fn((path: string) => path === FILE ? copy : NO_COPY);
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
    expect([resolveFilePath.mock.calls, reveal.mock.calls]).toEqual([[['Fallout4', 'txst', JSON.stringify(JSON.parse(TEXT)), 'Diffuse']], [[LOOSE]]]);
  });

  it('shows a copy in an archive as it is, for the archive file system to read', async () => {
    const archived: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/instance/mods/Mod/Mod - Textures.ba2', file: FILE };
    const { definitionAt, reveal } = language(NONE, { copy: archived });

    await definitionAt(document(), NAMED + 2);

    expect(reveal.mock.calls).toEqual([[archived]]);
  });

  it('says what was searched when no copy exists, and leaves the editor where it is', async () => {
    const { definitionAt, reveal, reporter } = language(NONE, { copy: NO_COPY });

    expect(await definitionAt(document(), NAMED + 2)).toEqual({ ...SPAN, resolved: false });
    expect([reveal.mock.calls, reporter.shownFailures]).toEqual([[], [{ severity: 'warning', message: `Go to Definition cannot go to ${FILE}.`, detail: NO_COPY.none }]]);
  });

  it('says why mEdit could not tell which file the path names', async () => {
    const { definitionAt, reveal, reporter } = language(NONE, { resolve: () => Promise.resolve(localFailure('Data/Stain_d.dds is no path its asset type holds')) });

    expect(await definitionAt(document(), NAMED + 2)).toEqual({ ...SPAN, resolved: false });
    expect([reveal.mock.calls, reporter.shownFailures.map(({ severity, message, detail }) => [severity, message, detail])]).toEqual([
      [], [['warning', 'Go to Definition cannot go to Decals\\Stain_d.dds.', 'Data/Stain_d.dds is no path its asset type holds']],
    ]);
  });

  it('says why the Explorer could not show the copy', async () => {
    const { definitionAt, reporter } = language(NONE, { reveal: () => Promise.reject(new Error('The workspace did not take Mod - Textures.ba2 as a folder.')) });

    expect(await definitionAt(document(), NAMED + 2)).toEqual({ ...SPAN, resolved: false });
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: `Go to Definition cannot show ${FILE}.`, detail: 'The workspace did not take Mod - Textures.ba2 as a folder.' }]);
  });

  it('says why it cannot tell whether the field is a path, when mEdit cannot answer for the record', async () => {
    const { definitionAt, resolveFilePath, reporter } = language(NONE, { compare: () => Promise.reject(new Error('mEdit is down')) });

    expect(await definitionAt(document(), NAMED + 2)).toBeUndefined();
    expect([resolveFilePath.mock.calls, reporter.shownFailures]).toEqual([[], [{ severity: 'error', message: `Cannot tell whether ${HOLDER} names a file here.`, detail: 'mEdit is down' }]]);
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
