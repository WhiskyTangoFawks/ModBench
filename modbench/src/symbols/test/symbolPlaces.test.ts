import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const setInput = vi.hoisted(() => vi.fn<(input: ReferencesViewInput) => void>());
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  workspace: { openTextDocument: () => Promise.resolve({ lineAt: () => ({ text: '*Base.esm' }) }) },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import * as vscode from 'vscode';
import { showReferencedBy } from '../symbolPlaces';
import type { References } from '../symbolKind';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const PLUGINS_TXT = '/profiles/Default/plugins.txt';
const placeAt = (line: number) => new vscode.Location(vscode.Uri.file(PLUGINS_TXT), new vscode.Range(line, 1, line, 9));
const UNREAD = '/userlist.yaml: it does not read';

function referencedBy(answers: References[], anchorOf?: Parameters<typeof showReferencedBy>[0]['anchorOf']) {
  const reporter = recordingReporter();
  const references = vi.fn(() => Promise.resolve(answers.shift() ?? { locations: [], unread: [] }));
  const shown = showReferencedBy({ reporter, subject: 'Base.esm (Base Mod)', contextValue: 'modbench.pluginReferencedBy', references, ...(anchorOf && { anchorOf }) });
  return { reporter, references, shown };
}

beforeEach(() => { setInput.mockClear(); });

describe('referenced by lists the places in VS Code\'s References view (commands.md, `referenced by` under Symbol)', () => {
  it('titles the list with its subject, under its context value, anchored at the first place', async () => {
    await referencedBy([{ locations: [placeAt(2), placeAt(4)], unread: [] }]).shown;

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ title: 'Referenced By: Base.esm (Base Mod)', contextValue: 'modbench.pluginReferencedBy', location: placeAt(2) }));
  });

  it('anchors where its kind anchors it', async () => {
    await referencedBy([{ locations: [placeAt(2)], unread: [] }], () => Promise.resolve(placeAt(7))).shown;

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ location: placeAt(7) }));
  });

  it('notifies of each file it could not read, a gesture that landed in part (common.md, Reporting)', async () => {
    const { reporter, shown } = referencedBy([{ locations: [placeAt(2)], unread: [UNREAD, '/b: gone'] }]);
    await shown;

    expect([reporter.reports, reporter.shownFailures]).toEqual([[{
      severity: 'warning', message: 'Referenced by on Base.esm (Base Mod) could not read every file that may name it.', detail: `${UNREAD}\n/b: gone`,
    }], []]);
  });

  it.each([
    ['no file names it', [], 'No file names it.'],
    ['no file that could be read names it', [UNREAD], 'No file that could be read names it.'],
  ])('says that %s, which leaves the view where it was', async (_case, unread, why) => {
    const { reporter, shown } = referencedBy([{ locations: [], unread }]);
    await shown;

    expect([setInput.mock.calls, reporter.reports.filter(({ severity }) => severity === 'error').map(({ message, detail }) => [message, detail])])
      .toEqual([[], [['Could not list where files name Base.esm (Base Mod).', why]]]);
  });

  it.each([
    ['the symbol names nothing', [{ refused: 'Mod order resolves Base.esm to no plugin.' }], undefined, 'Mod order resolves Base.esm to no plugin.'],
    ['its kind finds no anchor', [{ locations: [], unread: [] }], () => Promise.resolve({ refused: 'No active plugin holds 000000:Base.esm.' }), 'No active plugin holds 000000:Base.esm.'],
  ])('says why it cannot list, where %s', async (_case, answers: References[], anchorOf, why) => {
    const { reporter, shown } = referencedBy(answers, anchorOf);
    await shown;

    expect([setInput.mock.calls, reporter.reports.map(({ severity, detail }) => [severity, detail])]).toEqual([[], [['error', why]]]);
  });
});

describe('the line above the list, read again (common.md, States, story 3)', () => {
  it.each([
    { found: [], unread: [], message: 'No references found.' },
    { found: [], unread: [UNREAD], message: 'No references found in the files that could be read.' },
    { found: [placeAt(0), placeAt(1)], unread: [UNREAD], message: undefined },
  ])('is $message where $found.length places are found and $unread.length files are unread', async ({ found, unread, message }) => {
    await referencedBy([{ locations: [placeAt(0)], unread: [] }, { locations: found, unread }]).shown;
    const shown = present(setInput.mock.lastCall?.[0], 'the list shown');
    await shown.resolve();

    expect((await shown.resolve()).message).toBe(message);
  });

  it('says why, and lists nothing, where the symbol names nothing on the read again', async () => {
    const { reporter, shown: listed } = referencedBy([{ locations: [placeAt(0)], unread: [] }, { refused: 'Mods lists no mod named Gone.' }]);
    await listed;
    const shown = present(setInput.mock.lastCall?.[0], 'the list shown');
    await shown.resolve();

    expect([(await shown.resolve()).message, reporter.reports.map(({ detail }) => detail)]).toEqual(['No references found in the files that could be read.', ['Mods lists no mod named Gone.']]);
  });
});
