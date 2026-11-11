import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const { setInput, TEXT } = vi.hoisted(() => ({ setInput: vi.fn(), TEXT: '{ "FormKey": "000801:Mod.esp", "Diffuse": "Decals\\\\Stain_d.dds" }' }));
vi.mock('vscode', () => ({
  Uri, TreeItem, TreeItemCollapsibleState,
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
  workspace: { openTextDocument: () => Promise.resolve({ getText: () => TEXT, positionAt: (offset: number) => offset }) },
}));

import { fileLanguage, type FileClient } from '../fileLanguage';
import { recordingReporter } from '../../test/surfacingDoubles';

const HOLDER = '000801:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/TextureSet.json';
const NAMED = TEXT.indexOf('Decals');
const FILE = 'textures/decals/stain_d.dds';
const UNREAD = '000802:Mod.esp in Mod.esp (Mod): mEdit has no schema for its record type xxxx';

function language(answer: Awaited<ReturnType<FileClient['getFileReferences']>>) {
  const reporter = recordingReporter();
  const getFileReferences = vi.fn(() => Promise.resolve(answer));
  const client: FileClient = {
    getFileReferences,
    getRecordOwner: () => Promise.resolve(undefined),
    getCopyDocument: () => Promise.resolve({ kind: 'OwnFile' as const, location: SOURCE }),
  };
  return { reporter, getFileReferences, ...fileLanguage({ reporter, client }) };
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
