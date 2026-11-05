import { describe, expect, it, vi } from 'vitest';
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
};

function plugin() {
  const reporter = recordingReporter();
  const language = pluginLanguage({
    instance: { value: { plugins: [{ ...BASE, path: '/data/Base.esm', line: 0, enabled: true, winning: true }] } },
    reporter,
    client: { getCopyDocument: () => Promise.resolve(null), getRecordOwner: () => Promise.resolve(undefined) },
    owners: [ownerThatCannotReadAFile],
  });
  return { language, reporter };
}

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
