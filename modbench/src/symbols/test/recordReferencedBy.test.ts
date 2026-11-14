import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Range, TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

const { handlers, setInput } = vi.hoisted(() => ({
  handlers: new Map<string, (clicked?: unknown) => Promise<void>>(),
  setInput: vi.fn<(input: ReferencesViewInput<ReferencedByList>) => void>(),
}));
vi.mock('vscode', () => ({
  Uri, Range, TreeItem, TreeItemCollapsibleState,
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
  commands: { registerCommand: (command: string, handler: (clicked?: unknown) => Promise<void>) => { handlers.set(command, handler); return { dispose: vi.fn() }; } },
  extensions: { getExtension: () => ({ activate: () => Promise.resolve({ setInput }) }) },
}));

import * as vscode from 'vscode';
import { registerRecordReferencedBy } from '../recordReferencedBy';
import type { ReferencesViewInput } from '../../drivingLib/referencesView';
import type { ReferencedByList } from '../referrerTree';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { comparisonOf } from '../../test/comparison';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const GUN = '000801:A.esp';
const recordRow = { argument: { kind: 'record', formKey: GUN, plugin: { name: 'A.esp', origin: 'ModA' } } };
const anchor = new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Range(3, 15, 3, 15));
const moved = () => new vscode.Location(vscode.Uri.file('/its/document.json'), new vscode.Range(9, 15, 9, 15));
const IN_ACTIVE_OR_COMPILED = 'getReferencesInActiveOrCompiledPlugins';

beforeEach(() => { handlers.clear(); setInput.mockClear(); });

function asking(focusedOrPickedRecord: () => Promise<string | undefined> = () => Promise.resolve(GUN)) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getComparison', comparisonOf(GUN, [{ plugin: 'A.esp', isWinner: true, editorId: 'Gun' }]));
  client.setQueryAnswer('getPlugins', []);
  client.setQueryAnswer(IN_ACTIVE_OR_COMPILED, [{
    formKey: '000900:A.esp', plugin: 'A.esp', origin: 'ModA', fieldPath: 'Keywords[0]', recordType: 'weap', recordTypeName: 'Weapon', editorId: 'Rifle',
  }]);
  const locateRecord = vi.fn<Parameters<typeof registerRecordReferencedBy>[0]['locateRecord']>(() => Promise.resolve(anchor));
  const reporter = recordingReporter();
  registerRecordReferencedBy({ client, reporter, locateRecord, focusedOrPickedRecord });
  const referencesAsked = () => client.calls.filter(({ method }) => method.startsWith('getReferences')).map(({ method, args }) => [method, ...args]);
  const ask = async (...args: unknown[]): Promise<ReferencesViewInput<ReferencedByList> | undefined> => {
    const shown = setInput.mock.calls.length;
    await present(handlers.get('modbench.record.referencedBy'), 'the referenced by command')(...args);
    return setInput.mock.calls.slice(shown).at(-1)?.[0];
  };
  return { reporter, locateRecord, referencesAsked, ask };
}

const rowsOf = async (input: ReferencesViewInput<ReferencedByList> | undefined) => (await present(input, 'the list shown').resolve()).provider.getChildren();

describe('Referenced By on a record, answered in VS Code\'s References view (editor-referenced-by.md, Asking)', () => {
  it('shows the clicked record\'s list, titled by its EditorID and anchored at its FormKey in that copy\'s document', async () => {
    const { ask, locateRecord } = asking();

    const input = await ask(recordRow, [recordRow]);

    expect(input?.title).toBe('Referenced By: Gun');
    expect(locateRecord).toHaveBeenCalledWith({ kind: 'record', formKey: GUN, plugin: recordRow.argument.plugin });
    expect(input?.location).toBe(anchor);
    expect((await rowsOf(input)).map((row) => row.label)).toEqual(['Rifle']);
  });

  it('asks about the record in focus, or the one the user picks, from the palette', async () => {
    const { ask, locateRecord } = asking(() => Promise.resolve('000802:A.esp'));

    await ask();

    expect(locateRecord).toHaveBeenCalledWith({ kind: 'record', formKey: '000802:A.esp' });
  });

  it('shows nothing when the palette finds no record to ask about', async () => {
    const { ask } = asking(() => Promise.resolve(undefined));

    expect(await ask()).toBeUndefined();
  });

  it('reads the list only when the view resolves it, and again on each refresh, wherever the view moves its anchor', async () => {
    const { ask, referencesAsked } = asking();
    const input = present(await ask(recordRow), 'the list shown');
    expect(referencesAsked()).toEqual([]);

    await input.resolve();
    const refreshed = input.with(moved());
    await refreshed.resolve();

    expect(referencesAsked()).toEqual([[IN_ACTIVE_OR_COMPILED, GUN], [IN_ACTIVE_OR_COMPILED, GUN]]);
    expect(refreshed.title).toBe(input.title);
  });

  it('gives each list its own rows, so the same record asked about again shows collapsed, and the view\'s refresh keeps what was expanded', async () => {
    const { ask } = asking();
    const first = present(await ask(recordRow), 'the first list');
    const again = present(await ask(recordRow), 'the list asked for again');
    const refreshed = first.with(moved());
    const idsOf = async (input: ReferencesViewInput<ReferencedByList>) => (await rowsOf(input)).map((row) => row.id);

    expect(await idsOf(again)).not.toEqual(await idsOf(first));
    expect(await idsOf(refreshed)).toEqual(await idsOf(first));
  });

  it('is refused for what names no record', async () => {
    const { ask, reporter } = asking();

    expect(await ask({ argument: { kind: 'mod', name: 'ModA' } })).toBeUndefined();
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not list what references a record.', detail: 'What was given names no record.' }]);
  });

  it.each([
    [{ refused: 'A.esp (ModA) holds no 000801:A.esp.' }, 'A.esp (ModA) holds no 000801:A.esp.'],
    [undefined, 'No active plugin holds 000801:A.esp.'],
  ])('is refused, saying why, when the record has no place in a document: %j', async (located, why) => {
    const { ask, locateRecord, reporter } = asking();
    locateRecord.mockResolvedValue(located);

    expect(await ask(recordRow)).toBeUndefined();
    expect(reporter.reports).toEqual([{ severity: 'error', message: `Could not list what references ${GUN}.`, detail: why }]);
  });
});
