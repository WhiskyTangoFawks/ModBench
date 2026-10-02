import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import { compareOverride, compareResultFixture, diffNode, fieldMeta, panelClient, required, type PanelOpts } from './test/fixtures';
import type { CompareResult, PluginLoadFailure } from './types';

const FORM_KEY = '000001:Fallout4.esm';
const TOOLTIP = 'Written; waiting for the disk to confirm';
const nameMeta = fieldMeta({ name: 'Name', type: 'string' });
const formIdMeta = fieldMeta({ name: 'FormKey', type: 'string', displayLabel: 'FormID', isRecordHeaderMember: true, isRecordFormKey: true });
const formId = { metadata: formIdMeta, value: FORM_KEY };

function recordNamed(name: string): CompareResult {
  return compareResultFixture({
    overrides: [
      compareOverride({ formKey: FORM_KEY, plugin: 'Fallout4.esm', editorId: 'TestNPC', fields: [formId, { metadata: nameMeta, value: 'Original' }] }),
      compareOverride({ formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC', fields: [formId, { metadata: nameMeta, value: name }] }),
    ],
    diffs: [
      diffNode({ fieldName: 'FormKey', values: { 'Fallout4.esm': FORM_KEY, 'MyMod.esp|ModA': FORM_KEY } }),
      diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'Original', 'MyMod.esp|ModA': name } }),
    ],
  });
}

const plugins = [
  { name: 'Fallout4.esm', isImmutable: true },
  { name: 'MyMod.esp', origin: 'ModA', isTracked: true },
];

let disk = recordNamed('Before');

function renderPanel(opts: PanelOpts = {}) {
  const client = panelClient(() => disk, { plugins, ...opts });
  return { client, ...render(<RecordPanel client={client} />) };
}

const send = (data: unknown) => { act(() => { window.dispatchEvent(new MessageEvent('message', { data })); }); };
const reported = () => send({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: FORM_KEY });

const nameCell = () => {
  const row = required(screen.getByText('Name').closest('tr'), 'the Name row');
  return required(row.querySelectorAll('td')[2], "MyMod.esp's Name cell");
};

function hostHearsTheEdit() {
  const edit = required(vi.mocked(vscode.postMessage).mock.calls.map(([m]) => m)
    .findLast(m => m.type === WEBVIEW_TO_EXTENSION.EDIT_FIELD), 'the posted edit');
  send({ ...edit, type: EXTENSION_TO_WEBVIEW.EDIT_WRITTEN });
}

async function editName(value: string, { heard = true } = {}) {
  await waitFor(() => screen.getByText('Before'));
  fireEvent.doubleClick(within(nameCell()).getByText('Before'));
  const input = required(nameCell().querySelector('input'), "the cell's input");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  if (heard) hostHearsTheEdit();
}

const logged = () => vi.mocked(vscode.postMessage).mock.calls.map(([m]) => m)
  .filter(m => m.type === WEBVIEW_TO_EXTENSION.LOG);

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', FORM_KEY);
  vi.mocked(vscode.postMessage).mockClear();
  disk = recordNamed('Before');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('a record field edit, until mEdit confirms it (common.md, Unconfirmed writes)', () => {
  it('shows the new value in the cell at once, and the mark only after a short delay', async () => {
    renderPanel();
    await editName('After');

    expect(nameCell()).toHaveTextContent('After');
    expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument();
    await waitFor(() => expect(within(nameCell()).getByTitle(TOOLTIP)).toBeInTheDocument());
    expect(within(nameCell()).getByTitle(TOOLTIP).querySelector('.codicon.codicon-sync.codicon-modifier-spin')).not.toBeNull();
  });

  it('shows the disk value, unmarked, once a read asked after the write lands, and says nothing when it is what was written', async () => {
    renderPanel();
    await editName('After');
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));

    disk = recordNamed('After');
    reported();

    await waitFor(() => expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument());
    expect(nameCell()).toHaveTextContent('After');
    expect(logged()).toEqual([]);
  });

  it('shows what the disk holds when it differs from the write, with one line in the Output naming the field', async () => {
    renderPanel();
    await editName('After');

    disk = recordNamed('Elsewhere');
    reported();

    await waitFor(() => expect(nameCell()).toHaveTextContent('Elsewhere'));
    await waitFor(() => expect(logged()).toEqual([{
      type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn',
      message: '[recordPanel] Name of TestNPC [000001:Fallout4.esm] in "MyMod.esp" was written "After", and the disk now shows "Elsewhere".',
    }]));
    expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument();
  });

  it('goes on the read every panel makes once a refresh lands', async () => {
    renderPanel();
    await editName('After');
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));

    disk = recordNamed('After');
    send({ type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED });

    await waitFor(() => expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument());
  });

  it('is not covered by a read asked for before the write', async () => {
    let answer: (value: Awaited<ReturnType<NonNullable<PanelOpts['load']>>>) => void = () => undefined;
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('Before'));
    vi.mocked(client.load).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    reported();
    await editName('After');

    act(() => { answer({ ok: true, result: recordNamed('Before'), immutableSet: null, trackedSet: null, conflictsComputed: true, loadFailures: [] }); });

    await waitFor(() => expect(within(nameCell()).getByTitle(TOOLTIP)).toBeInTheDocument());
    expect(nameCell()).toHaveTextContent('After');
  });

  it('is not covered by a read the host posted before it heard the write', async () => {
    renderPanel();
    await editName('After', { heard: false });
    reported();
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));
    expect(nameCell()).toHaveTextContent('After');

    hostHearsTheEdit();
    disk = recordNamed('After');
    reported();

    await waitFor(() => expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument());
    expect(logged()).toEqual([]);
  });

  it('shows the disk value at once, unmarked, when mEdit refuses the write', async () => {
    renderPanel();
    await editName('After');
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));

    send({
      type: EXTENSION_TO_WEBVIEW.EDIT_REFUSED, formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Name' }], value: 'After' },
    });

    expect(nameCell()).toHaveTextContent('Before');
    expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument();
    expect(logged()).toEqual([]);
  });

  it('keeps the mark while mEdit cannot read the plugin', async () => {
    const unreadable: PluginLoadFailure[] = [{ name: 'MyMod.esp', origin: 'ModA', reason: 'truncated' }];
    const { client } = renderPanel();
    await editName('After');
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));
    vi.mocked(client.load).mockResolvedValueOnce({
      ok: true, result: recordNamed('Before'), immutableSet: null, trackedSet: null, conflictsComputed: true, loadFailures: unreadable,
    });

    reported();

    await waitFor(() => screen.getByText(/Showing the last good read/));
    expect(nameCell()).toHaveTextContent('After');
    expect(within(nameCell()).getByTitle(TOOLTIP)).toBeInTheDocument();
  });

  it('keeps the mark when the read fails', async () => {
    const { client } = renderPanel();
    await editName('After');
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));
    vi.mocked(client.load).mockResolvedValueOnce({ ok: false, error: 'mEdit is not answering' });

    reported();

    await waitFor(() => screen.getByText(/Showing the last good read: mEdit is not answering/));
    expect(nameCell()).toHaveTextContent('After');
    expect(within(nameCell()).getByTitle(TOOLTIP)).toBeInTheDocument();
  });

  const writtenTo = (formKey: string, origin: string, value: string) => send({
    type: EXTENSION_TO_WEBVIEW.EDIT_WRITTEN, formKey, plugin: 'MyMod.esp', origin,
    envelope: { op: 'set', path: [{ kind: 'member', name: 'Name' }], value },
  });

  it('shows and marks a write to the record from another entry point, and none to another record', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('Before'));

    writtenTo(FORM_KEY, 'ModA', 'Palette');
    writtenTo('000002:Fallout4.esm', 'ModA', 'Other');

    expect(nameCell()).toHaveTextContent('Palette');
    await waitFor(() => expect(within(nameCell()).getByTitle(TOOLTIP)).toBeInTheDocument());
  });

  it('marks the column of the plugin written, and not one of the same file name in another origin', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('Before'));

    writtenTo(FORM_KEY, 'ModB', 'Elsewhere');
    expect(nameCell()).toHaveTextContent('Before');

    writtenTo(FORM_KEY, 'ModA', 'Palette');
    expect(nameCell()).toHaveTextContent('Palette');
  });

  it('keeps the mark on its own cell when the panel hears its own write back', async () => {
    renderPanel();
    await editName('After');
    await waitFor(() => within(nameCell()).getByTitle(TOOLTIP));

    writtenTo(FORM_KEY, 'ModA', 'After');

    expect(within(nameCell()).getByTitle(TOOLTIP)).toBeInTheDocument();
  });

  it('forgets its marks when the tab moves to another record', async () => {
    renderPanel();
    await editName('After');
    send({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' });
    send({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: FORM_KEY });

    await waitFor(() => expect(nameCell()).toHaveTextContent('Before'));
    expect(logged()).toEqual([]);
  });
});

describe('an edit of the FormID', () => {
  it('shows the FormKey typed, plain and marked, until the disk confirms it', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('Before'));
    const row = required(screen.getByText('FormID').closest('tr'), 'the FormID row');
    const cell = required(row.querySelectorAll('td')[2], "MyMod.esp's FormID cell");
    fireEvent.doubleClick(within(cell).getByText('TestNPC [000001:Fallout4.esm]'));
    const input = required(cell.querySelector('input'), "the FormID cell's input");
    fireEvent.change(input, { target: { value: '000900:MyMod.esp' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    hostHearsTheEdit();

    expect(cell).toHaveTextContent(/^000900:MyMod\.esp$/);
    await waitFor(() => expect(within(cell).getByTitle(TOOLTIP)).toBeInTheDocument());
  });
});

describe('a replaced element of an array without a key', () => {
  const itemsMeta = fieldMeta({ name: 'Items', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'string' }) });
  // mEdit's alignment, in sequence, of the master's ['A', 'B'] and MyMod.esp's ['A', mine].
  const items = (mine: string): CompareResult => compareResultFixture({
    overrides: [
      compareOverride({ formKey: FORM_KEY, plugin: 'Fallout4.esm', editorId: 'TestNPC', fields: [{ metadata: itemsMeta, value: ['A', 'B'] }] }),
      compareOverride({
        formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: itemsMeta, value: ['A', mine] }],
      }),
    ],
    diffs: [diffNode({
      fieldName: 'Items', values: { 'Fallout4.esm': ['A', 'B'], 'MyMod.esp|ModA': ['A', mine] },
      children: [
        diffNode({ fieldName: '[0]', values: { 'Fallout4.esm': 'A', 'MyMod.esp|ModA': 'A' }, indexes: { 'Fallout4.esm': 0, 'MyMod.esp|ModA': 0 } }),
        ...(mine === 'B'
          ? [diffNode({ fieldName: '[1]', values: { 'Fallout4.esm': 'B', 'MyMod.esp|ModA': 'B' }, indexes: { 'Fallout4.esm': 1, 'MyMod.esp|ModA': 1 } })]
          : [
              diffNode({ fieldName: '[1]', values: { 'Fallout4.esm': 'B', 'MyMod.esp|ModA': null }, indexes: { 'Fallout4.esm': 1 } }),
              diffNode({ fieldName: '[2]', values: { 'Fallout4.esm': null, 'MyMod.esp|ModA': mine }, indexes: { 'MyMod.esp|ModA': 1 } }),
            ]),
      ],
    })],
  });
  const myCell = (row: string) =>
    required(required(screen.getByText(row).closest('tr'), `the ${row} row`).querySelectorAll('td')[2], `MyMod.esp's ${row} cell`);

  async function writeSecondElement(value: string) {
    disk = items('B');
    renderPanel();
    await waitFor(() => screen.getByText('[1]'));
    fireEvent.doubleClick(within(myCell('[1]')).getByText('B'));
    const input = required(myCell('[1]').querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
    hostHearsTheEdit();
  }

  it('says once that the disk shows something else, though the element now aligns on another row', async () => {
    await writeSecondElement('Z');

    disk = items('Y');
    reported();

    await waitFor(() => expect(logged()).toEqual([{
      type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn',
      message: '[recordPanel] [2] of TestNPC [000001:Fallout4.esm] in "MyMod.esp" was written "Z", and the disk now shows "Y".',
    }]));
  });

  it('says nothing when the disk holds what was written', async () => {
    await writeSecondElement('Z');

    disk = items('Z');
    reported();

    await waitFor(() => expect(myCell('[2]')).toHaveTextContent(/^Z$/));
    expect(logged()).toEqual([]);
  });
});

describe('a replaced element after a null slot', () => {
  const itemsMeta = fieldMeta({ name: 'Items', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'string' }) });
  const items = (last: string): CompareResult => compareResultFixture({
    overrides: [compareOverride({
      formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: itemsMeta, value: ['A', null, last] }],
    })],
    diffs: [diffNode({
      fieldName: 'Items', values: { 'MyMod.esp|ModA': ['A', null, last] },
      children: [
        diffNode({ fieldName: '[0]', values: { 'MyMod.esp|ModA': 'A' }, indexes: { 'MyMod.esp|ModA': 0 } }),
        diffNode({ fieldName: '[1]', values: { 'MyMod.esp|ModA': null }, indexes: { 'MyMod.esp|ModA': 1 } }),
        diffNode({ fieldName: '[2]', values: { 'MyMod.esp|ModA': last }, indexes: { 'MyMod.esp|ModA': 2 } }),
      ],
    })],
  });
  const lastCell = () =>
    required(required(screen.getByText('[2]').closest('tr'), 'the [2] row').querySelectorAll('td')[1], "MyMod.esp's [2] cell");

  it('is marked until the covering read, which clears the mark and says what the disk shows', async () => {
    disk = items('B');
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    send({
      type: EXTENSION_TO_WEBVIEW.EDIT_WRITTEN, formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Items' }, { kind: 'index', index: 2 }], value: 'Z' },
    });
    expect(lastCell()).toHaveTextContent(/^Z$/);
    await waitFor(() => expect(within(lastCell()).getByTitle(TOOLTIP)).toBeInTheDocument());

    disk = items('Y');
    reported();

    await waitFor(() => expect(lastCell()).toHaveTextContent(/^Y$/));
    expect(within(lastCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument();
    expect(logged()).toEqual([{
      type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn',
      message: '[recordPanel] [2] of TestNPC [000001:Fallout4.esm] in "MyMod.esp" was written "Z", and the disk now shows "Y".',
    }]);
  });
});

describe('a field in a row collapsed by the time the read lands', () => {
  const boundsMeta = fieldMeta({ name: 'Bounds', type: 'struct', fields: [fieldMeta({ name: 'X', type: 'int' })] });
  const bounds = (x: number): CompareResult => compareResultFixture({
    overrides: [compareOverride({
      formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: boundsMeta, value: { X: x } }],
    })],
    diffs: [diffNode({
      fieldName: 'Bounds', values: { 'MyMod.esp|ModA': { X: x } },
      children: [diffNode({ fieldName: 'X', values: { 'MyMod.esp|ModA': x } })],
    })],
  });

  it('still says once that the disk shows something else', async () => {
    disk = bounds(1);
    renderPanel();
    await waitFor(() => screen.getByText('X'));
    const xCell = required(required(screen.getByText('X').closest('tr'), 'the X row').querySelectorAll('td')[1], 'the X cell');
    fireEvent.doubleClick(within(xCell).getByText('1'));
    const input = required(xCell.querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    hostHearsTheEdit();
    fireEvent.doubleClick(required(screen.getByText('Bounds').closest('td'), 'the Bounds label'));
    await waitFor(() => expect(screen.queryByText('X')).not.toBeInTheDocument());

    disk = bounds(7);
    reported();

    await waitFor(() => expect(logged()).toEqual([{
      type: WEBVIEW_TO_EXTENSION.LOG, level: 'warn',
      message: '[recordPanel] X of TestNPC [000001:Fallout4.esm] in "MyMod.esp" was written "5", and the disk now shows "7".',
    }]));
  });
});

describe('an element added, removed or moved, until mEdit confirms it (common.md, Unconfirmed writes, story 2)', () => {
  const valuesMeta = fieldMeta({ name: 'Values', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }) });
  const values = (held: number[]): CompareResult => compareResultFixture({
    overrides: [compareOverride({
      formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: valuesMeta, value: held }],
    })],
    diffs: [diffNode({
      fieldName: 'Values', values: { 'MyMod.esp|ModA': held },
      children: held.map((v, i) => diffNode({ fieldName: `[${i}]`, values: { 'MyMod.esp|ModA': v }, indexes: { 'MyMod.esp|ModA': i } })),
    })],
  });
  const VALUES = { kind: 'member', name: 'Values' } as const;
  const at = (index: number) => ({ kind: 'index', index }) as const;
  const cellIn = (label: string) =>
    required(required(screen.getByText(label).closest('tr'), `the ${label} row`).querySelectorAll('td')[1], `the ${label} cell`);
  const rowLabels = () => screen.getAllByRole('row').slice(1).map(row => row.querySelector('td')?.textContent);
  const written = (envelope: unknown, type: string = EXTENSION_TO_WEBVIEW.EDIT_WRITTEN) =>
    send({ type, formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', envelope });
  const marked = () => screen.queryAllByTitle(TOOLTIP).map(mark => mark.closest('tr')?.querySelector('td')?.textContent);
  const messages = () => logged().map(m => ('message' in m ? m.message : ''));

  beforeEach(() => { disk = values([1, 2, 3]); });

  it('leaves every row where it is, and marks the removed row only after a delay', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    const before = rowLabels();

    written({ op: 'remove', path: [VALUES, at(1)] });

    expect(rowLabels()).toEqual(before);
    expect(marked()).toEqual([]);
    await waitFor(() => expect(marked()).toEqual(['[1]']));
    expect(cellIn('[1]')).toHaveTextContent('2');
    expect(within(cellIn('[1]')).getByTitle(TOOLTIP).querySelector('.codicon.codicon-sync.codicon-modifier-spin')).not.toBeNull();
    expect(rowLabels()).toEqual(before);
  });

  it('marks the array an element is added to, though its row is open', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));

    written({ op: 'add', path: [VALUES] });

    await waitFor(() => expect(marked()).toEqual([expect.stringMatching(/Values$/)]));
    expect(screen.queryByText('[3]')).not.toBeInTheDocument();
  });

  it('marks the moved row', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));

    written({ op: 'move', path: [VALUES, at(0)], value: 1 });

    await waitFor(() => expect(marked()).toEqual(['[0]']));
    expect(cellIn('[0]')).toHaveTextContent('1');
  });

  it('shows the disk\'s shape, unmarked and with nothing said, once a read shows the write', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    written({ op: 'remove', path: [VALUES, at(1)] });
    written({ op: 'move', path: [VALUES, at(0)], value: 1 });
    await waitFor(() => expect(marked()).toEqual(['[0]', '[1]']));

    disk = values([3, 1]);
    reported();

    await waitFor(() => expect(screen.queryByText('[2]')).not.toBeInTheDocument());
    expect(marked()).toEqual([]);
    expect(logged()).toEqual([]);
  });

  it('says once in the Output that the disk does not show a remove, an add or a move, and shows the disk', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    written({ op: 'remove', path: [VALUES, at(1)] });
    written({ op: 'add', path: [VALUES] });
    written({ op: 'move', path: [VALUES, at(0)], value: 1 });

    reported();

    const record = 'Values of TestNPC [000001:Fallout4.esm] in "MyMod.esp"';
    await waitFor(() => expect(messages()).toEqual([
      `[recordPanel] An element was removed from ${record}, and the disk does not show it.`,
      `[recordPanel] An element was added to ${record}, and the disk does not show it.`,
      `[recordPanel] An element was moved in ${record}, and the disk does not show the move.`,
    ]));
    expect(marked()).toEqual([]);
    expect(screen.getByText('[2]')).toBeInTheDocument();
  });

  it('says nothing of a move between two equal elements, which leaves the disk as it was', async () => {
    disk = values([1, 1, 3]);
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    written({ op: 'move', path: [VALUES, at(0)], value: 1 });
    await waitFor(() => expect(marked()).toEqual(['[0]']));

    reported();

    await waitFor(() => expect(marked()).toEqual([]));
    expect(logged()).toEqual([]);
  });

  it('shows no mark when mEdit refuses the write', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));

    vi.useFakeTimers();
    try {
      written({ op: 'remove', path: [VALUES, at(1)] });
      written({ op: 'remove', path: [VALUES, at(1)] }, EXTENSION_TO_WEBVIEW.EDIT_REFUSED);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(marked()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The host tells a panel nothing more of a gesture mEdit never answered.
  it('keeps the mark of a gesture with no answer until a refresh reads the disk', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    written({ op: 'remove', path: [VALUES, at(1)] });
    await waitFor(() => expect(marked()).toEqual(['[1]']));

    disk = values([1, 3]);
    send({ type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED });

    await waitFor(() => expect(marked()).toEqual([]));
    expect(screen.queryByText('[2]')).not.toBeInTheDocument();
  });

  it('keeps the mark when the read fails', async () => {
    const { client } = renderPanel();
    await waitFor(() => screen.getByText('[2]'));
    written({ op: 'remove', path: [VALUES, at(1)] });
    await waitFor(() => expect(marked()).toEqual(['[1]']));
    vi.mocked(client.load).mockResolvedValueOnce({ ok: false, error: 'mEdit is not answering' });

    reported();

    await waitFor(() => screen.getByText(/Showing the last good read/));
    expect(marked()).toEqual(['[1]']);
  });
});
