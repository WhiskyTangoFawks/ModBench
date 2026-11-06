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
