import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandHandlers, editorVscode, executed } from './editorVscode';

vi.mock('vscode', () => editorVscode);

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { editorOver, forgetEditor, pageGlobal } from './editorHarness';

const A = { formKey: '000801:A.esp' };
const B = { formKey: '000802:A.esp' };
const ofRecord = (record: { formKey: string }, plugin?: { name: string; origin: string }) =>
  ({ argument: { kind: 'record', ...record, plugin } });
const COPY = { name: 'A.esp', origin: 'ModA' };
const WINNER = { name: 'B.esp', origin: 'ModB' };
const won = (record: { formKey: string }) => ({ ...record, plugin: WINNER });

beforeEach(forgetEditor);

function opening(selection: readonly unknown[] = []) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwners', [WINNER]);
  client.setQueryAnswer('getCopyDocument', { kind: 'Rendered', location: 'Doc.json' });
  client.setQueryAnswer('getComparison', null);
  const { vsCodeOpensTabs } = editorOver({ meditClient: client, selection: () => selection });
  const tabOn = vsCodeOpensTabs();
  return () => {
    const opens = executed().filter(([id]) => id === 'vscode.openWith');
    return {
      head: client.calls.filter(({ method }) => method === 'getCopyDocument').map(({ args: [plugin, formKey] }) => ({ formKey, plugin })),
      columns: opens.map(([, uri]) => { const tab = tabOn(uri); return tab && pageGlobal(tab, 'mEditColumns'); }),
      options: opens.map(([, , , options]) => options),
    };
  };
}

const grid = (head: object, columns: object[], preview: boolean) => ({ head: [head], columns: [columns], options: [{ viewColumn: -1, preview }] });
const NOTHING = { head: [], columns: [], options: [] };

describe('what modbench.record.open opens', () => {
  it.each([
    ['a click on one record opens its winning copy as a preview', ofRecord(A), [], grid(won(A), [], true)],
    ['pinned: true opens pinned', { ...ofRecord(A), pinned: true }, [], grid(won(A), [], false)],
    ['records that each ask pinned open pinned, as one grid', [{ ...ofRecord(A), pinned: true }, { ...ofRecord(B), pinned: true }], [],
      grid(won(A), [won(B)], false)],
    ['several records without pinned open one grid as a preview', [ofRecord(A), ofRecord(B)], [], grid(won(A), [won(B)], true)],
    ['a row opens its own copy: the plugin and origin its Argument names', { label: 'Gun', ...ofRecord(A, COPY) }, [],
      grid({ ...A, plugin: COPY }, [], true)],
    ['a row that carries no Argument opens nothing', { label: 'Types' }, [], NOTHING],
    ['a row whose Argument is not a record opens nothing', { argument: { kind: 'mod', name: 'ModA' } }, [], NOTHING],
    ['with no Argument, the records selected in the focused view open as one grid, a preview', undefined, [ofRecord(A, COPY), ofRecord(B)],
      grid({ ...A, plugin: COPY }, [won(B)], true)],
    ['an Argument that carries only pinned opens the focused view\'s selection, pinned', { pinned: true }, [ofRecord(A, COPY), ofRecord(B)],
      grid({ ...A, plugin: COPY }, [won(B)], false)],
    ['with no Argument and no record selected, nothing opens', undefined, [{ label: 'Types' }], NOTHING],
    ['an Argument wins over the focused view\'s selection', ofRecord(A), [ofRecord(B)], grid(won(A), [], true)],
  ])('%s', async (_, argument, selection, plan) => {
    const opened = opening(selection);

    await commandHandlers.get('modbench.record.open')?.(argument);

    expect(opened()).toEqual(plan);
  });
});

describe('modbench.record.openPinned', () => {
  const openAsked = () => executed().filter(([id]) => id === 'modbench.record.open').map(([, argument]) => argument);

  it.each([
    ['asks to open the whole menu selection pinned', ofRecord(A), [ofRecord(A), ofRecord(B)],
      [{ argument: { kind: 'record', ...A }, pinned: true }, { argument: { kind: 'record', ...B }, pinned: true }]],
    ['falls back to the clicked row when the selection is empty', ofRecord(A), [], [{ argument: { kind: 'record', ...A }, pinned: true }]],
    ['reads a tree row by the Argument it carries and skips a row that carries none', ofRecord(A, COPY), [ofRecord(A, COPY), { label: 'Types' }],
      [{ argument: { kind: 'record', ...A, plugin: COPY }, pinned: true }]],
  ])('%s, through open', async (_, row, selection, asked) => {
    opening();

    await commandHandlers.get('modbench.record.openPinned')?.(row, selection);

    expect(openAsked()).toEqual([asked]);
  });
});
