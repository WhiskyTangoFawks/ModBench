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

function recordNamed(name: string): CompareResult {
  return compareResultFixture({
    overrides: [
      compareOverride({ formKey: FORM_KEY, plugin: 'Fallout4.esm', editorId: 'TestNPC', fields: [{ metadata: nameMeta, value: 'Original' }] }),
      compareOverride({ formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC', fields: [{ metadata: nameMeta, value: name }] }),
    ],
    diffs: [diffNode({ fieldName: 'Name', values: { 'Fallout4.esm': 'Original', 'MyMod.esp|ModA': name } })],
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

async function editName(value: string) {
  await waitFor(() => screen.getByText('Before'));
  fireEvent.doubleClick(within(nameCell()).getByText('Before'));
  const input = required(nameCell().querySelector('input'), "the cell's input");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
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
      message: '[recordPanel] TestNPC [000001:Fallout4.esm]: Name [MyMod.esp] was written "After", and the disk now shows "Elsewhere".',
    }]));
    expect(within(nameCell()).queryByTitle(TOOLTIP)).not.toBeInTheDocument();
  });

  // A refresh rebuilds mEdit's index, and every panel reads again once the rebuild lands.
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

    expect(cell).toHaveTextContent(/^000900:MyMod\.esp$/);
    await waitFor(() => expect(within(cell).getByTitle(TOOLTIP)).toBeInTheDocument());
  });
});

// A sorted array's element is addressed at its place in the column, which the write itself moves.
describe('a replaced element of a sorted array', () => {
  const keywordsMeta = fieldMeta({ name: 'Keywords', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'formKey' }) });
  const keywords = (held: string[]): CompareResult => compareResultFixture({
    overrides: [compareOverride({
      formKey: FORM_KEY, plugin: 'MyMod.esp', origin: 'ModA', isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: keywordsMeta, value: held }],
    })],
    diffs: [diffNode({
      fieldName: 'Keywords', values: { 'MyMod.esp|ModA': held },
      children: held.map(k => diffNode({
        fieldName: k, values: { 'MyMod.esp|ModA': k },
        resolutions: { 'MyMod.esp|ModA': { state: 'ResolvedValidType', editorId: `Named${k}` } },
      })),
    })],
  });
  const cellOf = (keyword: string) => {
    const row = required(screen.getAllByText(keyword).map(e => e.closest('tr')).find(r => r !== null), `the ${keyword} row`);
    return required(row.querySelectorAll('td')[1], `the ${keyword} cell`);
  };

  it('shows the disk\'s order once the read lands, and says nothing of the element now in its place', async () => {
    disk = keywords(['KwdA', 'KwdC']);
    renderPanel();
    await waitFor(() => screen.getAllByText('KwdA'));
    fireEvent.click(cellOf('KwdA'));
    fireEvent.doubleClick(within(cellOf('KwdA')).getByText('NamedKwdA [KwdA]'));
    const request = required(vi.mocked(vscode.postMessage).mock.calls.map(([m]) => m)
      .find(m => m.type === WEBVIEW_TO_EXTENSION.OPEN_FORM_KEY_PICKER), 'the picker request');
    send({ type: EXTENSION_TO_WEBVIEW.FORM_KEY_PICKED, requestId: 'requestId' in request ? request.requestId : '', formKey: 'KwdZ' });
    // A reference the disk does not hold yet resolves to nothing.
    await waitFor(() => expect(cellOf('KwdA')).toHaveTextContent(/^KwdZ$/));

    disk = keywords(['KwdC', 'KwdZ']);
    reported();

    await waitFor(() => expect(screen.queryByText('KwdA')).not.toBeInTheDocument());
    expect(cellOf('KwdC')).toHaveTextContent('NamedKwdC [KwdC]');
    expect(cellOf('KwdZ')).toHaveTextContent('NamedKwdZ [KwdZ]');
    expect(logged()).toEqual([]);
  });
});
