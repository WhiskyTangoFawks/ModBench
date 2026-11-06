import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const setInput = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { textDocuments: [] },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import { pluginLanguage } from '../pluginLanguage';
import type { InstanceValue } from '../../instanceLoader/instance';
import type { SymbolOwner } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';

const BASE = { name: 'Base.esm', origin: 'Base Mod' };
const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const UNREAD = '/userlist.yaml: it does not read';

const ownerThatCannotReadAFile: SymbolOwner = {
  read: () => Promise.resolve({
    references: [{ place: { file: PLUGINS_TXT, start: { line: 0, character: 1 }, end: { line: 0, character: 9 } }, names: { name: 'Base.esm' } }],
    leftOut: [UNREAD],
  }),
  nameAt: () => Promise.resolve({ name: 'Base.esm' }),
  plan: () => Promise.reject(new Error('Not planned here.')),
};

function plugin() {
  const reporter = recordingReporter();
  const language = pluginLanguage({
    instance: { value: { plugins: [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }] } },
    reporter,
    client: { getCopyDocument: () => Promise.resolve(null), getRecordOwner: () => Promise.resolve(undefined) },
    owners: [ownerThatCannotReadAFile],
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
    expect(await naming('base.ESM').language.definitionAt(document, 14)).toBe(true);

    expect(goTo).toHaveBeenCalledWith(BASE);
  });

  it('says in the Output, and goes nowhere, when mod order resolves the name to no plugin', async () => {
    const { language, reporter } = naming('Gone.esp');

    expect(await language.definitionAt(document, 14)).toBe(true);

    expect([goTo.mock.calls.length, reporter.shownFailures.map(({ severity, detail }) => [severity, detail])]).toEqual([0, [['warning', 'Mod order resolves Gone.esp to no plugin.']]]);
  });

  it('answers where no plugin is named, so another feature may', async () => {
    expect(await naming().language.definitionAt(document, 3)).toBe(false);
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

  it('lists each plugin copy whose name holds the query, whatever the case', () => {
    expect(naming().language.symbolsFor('BASE').map(({ name, origin }) => ({ name, origin }))).toEqual([BASE, { name: 'Base.esm', origin: 'Other Mod' }]);
    expect(naming().language.symbolsFor('  ')).toEqual([]);
  });

  it('lists no line that names no file, which has no place in the workspace', () => {
    const { language } = naming(undefined, [{ ...MID, path: undefined, line: 0, enabled: true, winning: true }]);

    expect(language.symbolsFor('mid')).toEqual([]);
  });
});
