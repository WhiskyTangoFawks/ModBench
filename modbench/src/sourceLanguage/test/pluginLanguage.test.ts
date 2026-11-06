import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const setInput = vi.hoisted(() => vi.fn<(input: ReferencesViewInput) => void>());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { textDocuments: [], openTextDocument: () => Promise.resolve({ lineAt: () => ({ text: '*Base.esm' }) }) },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import { pluginLanguage } from '../pluginLanguage';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { SymbolOwner, SymbolReading } from '../../symbolNames/symbolNames';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const UNREAD = '/userlist.yaml: it does not read';

const namedAt = (line: number) => ({ place: { file: PLUGINS_TXT, start: { line, character: 1 }, end: { line, character: 9 } }, names: { name: 'Base.esm' } });

const ownerThatCannotReadAFile: SymbolOwner = {
  read: () => Promise.resolve({ references: [namedAt(0)], leftOut: [UNREAD] }),
  nameAt: () => Promise.resolve({ name: 'Base.esm' }),
  plan: () => Promise.reject(new Error('Not planned here.')),
};

function plugin(owner: SymbolOwner = ownerThatCannotReadAFile) {
  const reporter = recordingReporter();
  const language = pluginLanguage({
    instance: { value: { plugins: [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }] } },
    reporter,
    client: { getCopyDocument: () => Promise.resolve(null), getRecordOwner: () => Promise.resolve(undefined) },
    owners: [owner],
    renamePlugin: () => Promise.reject(new Error('Not renamed here.')),
    goTo: () => Promise.resolve(),
    tooltip: () => [],
  });
  return { language, reporter };
}

describe('Rename Symbol on a plugin\'s name is the plugin\'s rename (source.md, In the text editor)', () => {
  const document = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Mid.esp\r\n*base.ESM\r\n' };
  const renamePlugin = vi.fn(() => Promise.resolve());
  const naming = (name?: string) => pluginLanguage({
    instance: { value: { plugins: [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }] } },
    reporter: recordingReporter(),
    client: { getCopyDocument: () => Promise.resolve(null), getRecordOwner: () => Promise.resolve(undefined) },
    owners: [{ ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve(name === undefined ? undefined : { name }) }],
    renamePlugin,
    goTo: () => Promise.resolve(),
    tooltip: () => [],
  });
  beforeEach(() => { renamePlugin.mockClear(); });

  it('renames the plugin mod order resolves the name to, with the name VS Code asked for', async () => {
    await naming('base.ESM').renameAt(document, 14, 'New.esm');

    expect(renamePlugin).toHaveBeenCalledWith(BASE, 'New.esm');
  });

  it('offers the name under the place, as the file spells it', async () => {
    expect(await naming('Base.esm').renameRangeAt(document, 14)).toEqual({ start: 11, end: 19, name: 'base.ESM' });
  });

  it('offers nothing where no plugin\'s name is, and renames nothing a name resolves to no plugin', async () => {
    const gone = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Gone.esp\r\n' };

    expect(await naming().renameRangeAt(gone, 3)).toBeUndefined();
    await expect(naming('Gone.esp').renameAt(gone, 3, 'New.esp')).rejects.toThrow('Mod order resolves Gone.esp to no plugin.');
    expect(renamePlugin).not.toHaveBeenCalled();
  });
});

describe('what a plugin\'s references could not read, as each surface says it (common.md, Reporting)', () => {
  it('is a notification naming it for referenced by, a gesture that landed in part', async () => {
    const { language, reporter } = plugin();

    await language.referencedBy(BASE);

    expect(setInput).toHaveBeenCalled();
    expect([reporter.reports.map(({ severity, detail }) => [severity, detail]), reporter.shownFailures]).toEqual([[['warning', UNREAD]], []]);
  });

  it('is a line in the Output and no notification for Find All References, a VS Code feature that answers in part', async () => {
    const { language, reporter } = plugin();
    const document = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Base.esm' };

    const found = await language.referencesAt(document, 3);

    expect(found).toHaveLength(1);
    expect([reporter.reports, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['warning', UNREAD]]]);
  });
});

describe('the line above a plugin\'s list, read again (common.md, States, story 3)', () => {
  it.each([
    { found: [], unread: [], message: 'No references found.' },
    { found: [], unread: [UNREAD], message: 'No references found in the files that could be read.' },
    { found: [namedAt(0), namedAt(1)], unread: [UNREAD], message: undefined },
  ])('is $message where $found.length places are found and $unread.length files are unread', async ({ found, unread, message }) => {
    let reading: SymbolReading = { references: [namedAt(0)], leftOut: [] };
    const { language } = plugin({ ...ownerThatCannotReadAFile, read: () => Promise.resolve(reading) });
    await language.referencedBy(BASE);
    const shown = present(setInput.mock.lastCall?.[0], 'the list shown');
    await shown.resolve();
    reading = { references: found, leftOut: unread };

    expect((await shown.resolve()).message).toBe(message);
  });
});

describe('Go to Definition, hover, Go to Symbol and completion on a plugin (symbols.md, The features)', () => {
  const MID = { name: 'Mid.esp', origin: 'Mid Mod' };
  const rows = [BASE, { name: 'Base.esm', origin: 'Other Mod' }, MID].map((row, line) => ({ ...row, path: `/data/${row.name}`, line, enabled: true, winning: row.origin !== 'Other Mod' }));
  const goTo = vi.fn(() => Promise.resolve());
  const naming = (name?: string, plugins: InstanceValue['plugins'] = rows) => {
    const reporter = recordingReporter();
    const language = pluginLanguage({
      instance: { value: { plugins } },
      reporter,
      client: { getCopyDocument: () => Promise.resolve(null), getRecordOwner: () => Promise.resolve(undefined) },
      owners: [{ ...ownerThatCannotReadAFile, nameAt: () => Promise.resolve(name === undefined ? undefined : { name }) }],
      renamePlugin: () => Promise.reject(new Error('Not renamed here.')),
      goTo,
      tooltip: ({ name: file, origin }) => [file, origin, 'read-only'],
    });
    return { language, reporter };
  };
  const document = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Mid.esp\r\n*base.ESM\r\n' };
  beforeEach(() => { goTo.mockClear(); });

  it('goes to the plugin mod order resolves the name under the place to', async () => {
    expect(await naming('base.ESM').language.definitionAt(document, 14)).toEqual({ start: 11, end: 19, resolved: true });

    expect(goTo).toHaveBeenCalledWith(BASE);
  });

  it('says in the Output, and goes nowhere, when mod order resolves the name to no plugin', async () => {
    const { language, reporter } = naming('Gone.esp');
    const gone = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Gone.esp\r\n' };

    expect(await language.definitionAt(gone, 3)).toEqual({ start: 1, end: 9, resolved: false });

    expect([goTo.mock.calls.length, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([0, [['warning', 'Mod order resolves Gone.esp to no plugin.']]]);
  });

  it('answers where no plugin is named, so another feature may', async () => {
    expect(await naming().language.definitionAt(document, 3)).toBeUndefined();
  });

  it('hovers with the row\'s tooltip, over the name as the file spells it', async () => {
    expect(await naming('Base.esm').language.hoverAt(document, 14)).toEqual({ start: 11, end: 19, lines: ['Base.esm', 'Base Mod', 'read-only'] });
  });

  it('hovers with the name alone when mod order resolves it to no plugin', async () => {
    const gone = { uri: Uri.file(PLUGINS_TXT), getText: () => '*Gone.esp\r\n' };

    expect(await naming('Gone.esp').language.hoverAt(gone, 3)).toEqual({ start: 1, end: 9, lines: ['Gone.esp'] });
  });

  it('completes where a file names a plugin with every plugin, over the name typed so far', async () => {
    const found = await naming('Ba').language.completionsAt({ uri: Uri.file(PLUGINS_TXT), getText: () => '*Ba' }, 3);

    expect(found).toEqual({
      start: 1, end: 3,
      items: [{ name: 'Base.esm', origins: ['Base Mod', 'Other Mod'] }, { name: 'Mid.esp', origins: ['Mid Mod'] }],
    });
  });

  it('completes nothing where no plugin is named', async () => {
    expect(await naming().language.completionsAt(document, 3)).toBeUndefined();
  });

  const located = (found: { plugin: { name: string; origin: string }; location: unknown }[]) => found.map(({ plugin, location }) => [plugin.name, plugin.origin, location]);

  it('lists each plugin copy whose name holds the query, whatever the case, at its file', async () => {
    const found = await naming().language.symbolsFor('BASE');

    expect(located(found)).toEqual([
      ['Base.esm', 'Base Mod', { uri: Uri.file('/data/Base.esm'), range: new Range(0, 0, 0, 0) }],
      ['Base.esm', 'Other Mod', { uri: Uri.file('/data/Base.esm'), range: new Range(0, 0, 0, 0) }],
    ]);
    expect(await naming().language.symbolsFor('  ')).toEqual([]);
  });

  it('places a line that names no file at a place a file names it', async () => {
    const { language } = naming(undefined, [{ ...BASE, path: undefined, line: 0, enabled: true, winning: true }]);

    expect(located(await language.symbolsFor('base'))).toEqual([['Base.esm', 'Base Mod', { uri: Uri.file(PLUGINS_TXT), range: new Range(0, 1, 0, 9) }]]);
  });

  it('lists no plugin that has no file and that no file names', async () => {
    const { language } = naming(undefined, [{ ...MID, path: undefined, line: 0, enabled: true, winning: true }]);

    expect(await language.symbolsFor('mid')).toEqual([]);
  });
});
