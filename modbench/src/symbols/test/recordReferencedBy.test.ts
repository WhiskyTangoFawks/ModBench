import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';

const { setInput } = vi.hoisted(() => ({
  setInput: vi.fn<(input: ReferencesViewInput<ReferencedByList>) => void>(),
}));
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import * as vscode from 'vscode';
import { recordReferencedBy } from '../recordReferencedBy';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';
import type { ReferencedByList } from '../referrerTree';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { comparisonOf } from '../../test/comparison';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const GUN = '000801:A.esp';
const record = { kind: 'record', formKey: GUN } as const;
const anchor = new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Range(3, 15, 3, 15));
const moved = () => new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Range(9, 15, 9, 15));
const IN_ACTIVE_OR_COMPILED = 'getReferencesInActiveOrCompiledPlugins';

beforeEach(() => { setInput.mockClear(); });

function asking() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: true, editorId: 'Gun' }]));
  client.setQueryAnswer('getPlugins', []);
  client.setQueryAnswer(IN_ACTIVE_OR_COMPILED, [{
    formKey: '000900:A.esp', plugin: 'A.esp', origin: 'ModA', fieldPath: 'Keywords[0]', recordType: 'weap', recordTypeName: 'Weapon', editorId: 'Rifle',
  }]);
  const anchorOf = vi.fn<Parameters<typeof recordReferencedBy>[0]['anchorOf']>(() => Promise.resolve(anchor));
  const reporter = recordingReporter();
  const referencedBy = recordReferencedBy({ client, reporter, anchorOf });
  const referencesAsked = () => client.calls.filter(({ method }) => method.startsWith('getReferences')).map(({ method, args }) => [method, ...args]);
  const ask = async (): Promise<ReferencesViewInput<ReferencedByList> | undefined> => {
    const shown = setInput.mock.calls.length;
    await referencedBy(record);
    return setInput.mock.calls.slice(shown).at(-1)?.[0];
  };
  return { reporter, anchorOf, referencesAsked, ask };
}

const rowsOf = async (input: ReferencesViewInput<ReferencedByList> | undefined) => (await present(input, 'the list shown').resolve()).provider.getChildren();

describe('Referenced By on a record, answered in VS Code\'s References view (editor-referenced-by.md, Asking)', () => {
  it('shows the record\'s list, titled by its EditorID and anchored at its FormKey in its document', async () => {
    const { ask } = asking();

    const input = await ask();

    expect(input?.title).toBe('Referenced By: Gun');
    expect(input?.location).toBe(anchor);
    expect((await rowsOf(input)).map((row) => row.label)).toEqual(['Rifle']);
  });

  it('reads the list only when the view resolves it, and again on each refresh, wherever the view moves its anchor', async () => {
    const { ask, referencesAsked } = asking();
    const input = present(await ask(), 'the list shown');
    expect(referencesAsked()).toEqual([]);

    await input.resolve();
    const refreshed = input.with(moved());
    await refreshed.resolve();

    expect(referencesAsked()).toEqual([[IN_ACTIVE_OR_COMPILED, GUN], [IN_ACTIVE_OR_COMPILED, GUN]]);
    expect(refreshed.title).toBe(input.title);
  });

  it('gives each list its own rows, so the same record asked about again shows collapsed, and the view\'s refresh keeps what was expanded', async () => {
    const { ask } = asking();
    const first = present(await ask(), 'the first list');
    const again = present(await ask(), 'the list asked for again');
    const refreshed = first.with(moved());
    const idsOf = async (input: ReferencesViewInput<ReferencedByList>) => (await rowsOf(input)).map((row) => row.id);

    expect(await idsOf(again)).not.toEqual(await idsOf(first));
    expect(await idsOf(refreshed)).toEqual(await idsOf(first));
  });

  it('is refused, saying why, when the record has no place in a document', async () => {
    const { ask, anchorOf, reporter } = asking();
    anchorOf.mockResolvedValue({ refused: 'A.esp (ModA) holds no 000801:A.esp.' });

    expect(await ask()).toBeUndefined();
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Could not list what references ${GUN}.`, detail: 'A.esp (ModA) holds no 000801:A.esp.' }]);
  });
});
