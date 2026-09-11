import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import { recordPanelIncompleteMessage } from '../../src/medit/loadOrderProgress';
import { DIMMED_OPACITY } from './gridStyles';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import { fieldMeta, panelClient, type PanelOpts } from './test/fixtures';

const strMeta: FieldMetadata = fieldMeta({ name: 'Name', type: 'string' });

const compareResult = {
  conflictAll: 'Conflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm',
      plugin: 'Fallout4.esm',
      loadOrderIndex: 0,
      isWinner: false,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Original Name' },
      ],
      conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      loadOrderIndex: 1,
      isWinner: true,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Override Name' },
      ],
      conflictThis: 'ConflictWins',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp',
      cellStates: { 'MyMod.esp': 'ConflictWins' },
      conflictAll: 'Conflict',
    },
  ],
};

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

const immutableWinnerCompareResult = {
  conflictAll: 'OnlyOne',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name' },
      winnerColumn: 'Fallout4.esm', cellStates: {},
    },
  ],
};

const intMeta: FieldMetadata = fieldMeta({ name: 'Level', type: 'int' });
const fkMeta: FieldMetadata = fieldMeta({
  name: 'Race', type: 'formKey', validFormKeyTypes: ['race']});

const fkCompareResult = {
  conflictAll: 'OnlyOne',
  overrides: [
    {
      formKey: '000001:Fallout4.esm',
      plugin: 'Fallout4.esm',
      loadOrderIndex: 0,
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: fkMeta, value: '00013918:Fallout4.esm' }],
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Race',
      values: { 'Fallout4.esm': '00013918:Fallout4.esm' },
      winnerColumn: 'Fallout4.esm',
      cellStates: {},
      // ADR-0005: the backend carries a resolution signal per FormKey value; an unresolved
      // default would exercise no affordance at all.
      resolutions: { 'Fallout4.esm': { state: 'ResolvedValidType', recordType: 'race', editorId: 'HumanRace' } },
    },
  ],
};

const overrideCompareResult = {
  conflictAll: 'Override',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Override Name' }], conflictThis: 'Override' },
  ],
  diffs: [{ fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
    winnerColumn: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' },
    conflictAll: 'Override' }],
};

const twoSiblingFieldsResult = {
  conflictAll: 'Override',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }, { metadata: intMeta, value: 5 }], conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Override Name' }, { metadata: intMeta, value: 5 }], conflictThis: 'Override' },
  ],
  diffs: [
    { fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp', cellStates: { 'MyMod.esp': 'Override' },
      conflictAll: 'Override' },
    { fieldName: 'Level', values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 },
      winnerColumn: 'MyMod.esp', cellStates: {},
      conflictAll: 'NoConflict' },
  ],
};

const sameFilenameCompareResult = {
  conflictAll: 'Conflict',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Shared.esp', origin: 'ModA', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'FromA' }], conflictThis: 'Master', recordType: 'npc_' },
    { formKey: '000001:Fallout4.esm', plugin: 'Shared.esp', origin: 'ModB', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'FromB' }], conflictThis: 'ConflictWins', recordType: 'npc_' },
  ],
  diffs: [{
    fieldName: 'Name',
    values: { [columnKey('Shared.esp', 'ModA')]: 'FromA', [columnKey('Shared.esp', 'ModB')]: 'FromB' },
    winnerColumn: columnKey('Shared.esp', 'ModB'),
    cellStates: { [columnKey('Shared.esp', 'ModB')]: 'ConflictWins' },
  }],
};

const sameFilenamePluginsResponse = [
  { name: 'Shared.esp', origin: 'ModA', isImmutable: false, loadOrderIndex: 0 },
  { name: 'Shared.esp', origin: 'ModB', isImmutable: false, loadOrderIndex: 1 },
];

const notInLoadOrderCompareResult = {
  conflictAll: 'OnlyOne',
  overrides: [
    {
      formKey: '000001:Solo.esp', plugin: 'Solo.esp', origin: 'ShadowMod', loadOrderIndex: 5, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Shadowed value' }], conflictThis: 'OnlyOne', recordType: 'npc_',
    },
  ],
  diffs: [{
    fieldName: 'Name',
    values: { [columnKey('Solo.esp', 'ShadowMod')]: 'Shadowed value' },
    winnerColumn: columnKey('Solo.esp', 'ShadowMod'),
    cellStates: { [columnKey('Solo.esp', 'ShadowMod')]: 'OnlyOne' },
  }],
};

const notInLoadOrderPluginsResponse = [
  { name: 'Solo.esp', origin: 'ShadowMod', isImmutable: true, loadOrderIndex: 5, inLoadOrder: false },
];

// The Partial Form toggle is disabled on an untracked column, so the dispatch needs a tracked
// one.
const partialFormTrackedPluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
];

const partialFormCompareResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }], conflictThis: 'IdenticalToMaster',
      isPartialForm: true, isPartialFormable: true,
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': null },
      winnerColumn: 'Fallout4.esm',
      cellStates: {},
    },
  ],
};

// The document names both A and B, so the resting label reads "A, B".
const flagsFieldMeta: FieldMetadata = fieldMeta({
  name: 'Flags', type: 'flags',
  enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' }]});

const flagsCompareResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Original Name' },
        { metadata: flagsFieldMeta, value: ['A', 'B'] },
      ],
      conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Override Name' },
        { metadata: flagsFieldMeta, value: ['A', 'B'] },
      ],
      conflictThis: 'IdenticalToMaster',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp',
      cellStates: {},
    },
    {
      fieldName: 'Flags',
      values: { 'Fallout4.esm': ['A', 'B'], 'MyMod.esp': ['A', 'B'] },
      winnerColumn: 'MyMod.esp',
      cellStates: {},
    },
  ],
};

// MyMod.esp must be tracked for editableColumns to include it at all, so the real gate runs
// rather than a hand-fed set.
const flagsTrackedPluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
];

const structFieldMeta: FieldMetadata = fieldMeta({
  name: 'Bounds',
  type: 'struct',
  fields: [
    fieldMeta({ name: 'X', type: 'int' }),
    fieldMeta({ name: 'Y', type: 'int' }),
  ]});

const structCompareResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm',
      plugin: 'Fallout4.esm',
      loadOrderIndex: 0,
      isWinner: false,
      editorId: 'TestNPC',
      fields: [{ metadata: structFieldMeta, value: { X: 10, Y: 20 } }],
      conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      loadOrderIndex: 1,
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: structFieldMeta, value: { X: 15, Y: 20 } }],
      conflictThis: 'Override',
    },
  ],
  diffs: [
    {
      fieldName: 'Bounds',
      values: { 'Fallout4.esm': { X: 10, Y: 20 }, 'MyMod.esp': { X: 15, Y: 20 } },
      winnerColumn: 'MyMod.esp',
      cellStates: { 'MyMod.esp': 'Override' },
      children: [
        {
          fieldName: 'X',
          values: { 'Fallout4.esm': 10, 'MyMod.esp': 15 },
          winnerColumn: 'MyMod.esp',
          cellStates: { 'MyMod.esp': 'Override' },
        },
        {
          fieldName: 'Y',
          values: { 'Fallout4.esm': 20, 'MyMod.esp': 20 },
          winnerColumn: 'MyMod.esp',
          cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        },
      ],
    },
  ],
};

// `pluginsResponse` is this file's own default column set; every other option is the shared
// fixture's.
function renderPanel(compare: unknown, opts: PanelOpts = {}) {
  const client = panelClient(() => compare, { plugins: pluginsResponse, ...opts });
  return { client, ...render(<RecordPanel client={client} />) };
}

describe('RecordPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows "No record selected." when no formKey is set', () => {
    vi.stubGlobal('mEditFormKey', '');
    renderPanel(compareResult);
    expect(screen.getByText('No record selected.')).toBeInTheDocument();
  });

  it('shows the record title with editorId and formKey after loading', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText(/TestNPC \[000001:Fallout4\.esm\]/)).toBeInTheDocument());
  });

  it('shows field names from the diff table', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
  });

  // Master leftmost, winner rightmost, as in xEdit.
  it('shows each override\'s own field value in its own column', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

  // There is no edit mode. Editing affordances follow the column's plugin
  // mutability, not a mode the user has to enter on every record navigation.
  it('renders no Edit/View mode toggle', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  // ADR-0007: writing the binary is the separate Save & Compile gesture, scoped to a whole
  // plugin, never a per-plugin control on this panel.
  it('offers no per-plugin Save — writing the binary is Save & Compile, not this panel', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  // ADR-0018: a cell in an immutable column opens no input at all, however it is clicked —
  // nothing ever reaches a write from here.
  it('a cell in an immutable column opens nothing when clicked', async () => {
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Original Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

});


// ADR-0012: two columns sharing a filename but differing in origin — display never changes, so
// only the compound (plugin, origin) identity can tell them apart.

describe('RecordPanel — same-filename, different-origin columns', () => {
  afterEach(() => vi.unstubAllGlobals());

  // ADR-0012: filename in the header, origin inline only on collision. The rule is
  // response-driven — whatever same-filename pair arrives must render unambiguously.
  it('renders origin inline in both columns\' headers when two copies share a filename', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(sameFilenameCompareResult, { plugins: sameFilenamePluginsResponse });
    await waitFor(() => expect(screen.getByText('Shared.esp (ModB)')).toBeInTheDocument());
    expect(screen.getByText('Shared.esp (ModA)')).toBeInTheDocument();
    expect(screen.getByText('FromA')).toBeInTheDocument();
    expect(screen.getByText('FromB')).toBeInTheDocument();
    expect(screen.queryByText('Shared.esp')).not.toBeInTheDocument();
  });

  // The single-copy control: origin inline is collision-only, not "whenever origin isn't Data".
  it('does not render origin inline for a normal, non-colliding column', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());
    expect(screen.queryByText(/MyMod\.esp \(/)).not.toBeInTheDocument();
  });
});

describe('RecordPanel — column header native right-click menu', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the header cell carries the recordHeader context, naming this column\'s own record identity', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const compare = {
      conflictAll: 'OnlyOne',
      overrides: [{
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
        loadOrderIndex: 0, isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Test Name' }], conflictThis: 'OnlyOne',
      }],
      diffs: [{
        fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
        winnerColumn: 'MyMod.esp', cellStates: {},
      }],
    };
    const { container } = renderPanel(compare);
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    // The context lives on PluginHeader's own root div, nested inside RecordPanel's <th>.
    const headerRoot = container.querySelector('th > div');
    expect(JSON.parse(headerRoot!.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      preventDefaultContextMenuItems: true,
    });
  });
});

describe('RecordPanel — a copy the load order does not name (ADR-0013)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column header dimmed and labeled distinctly from a vanilla master', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Solo.esp');
    renderPanel(notInLoadOrderCompareResult, { plugins: notInLoadOrderPluginsResponse });
    await waitFor(() => expect(screen.getByText('Solo.esp')).toBeInTheDocument());

    expect(screen.getByText('(not loaded)')).toBeInTheDocument();
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();

    const th = screen.getByText('Solo.esp').closest('th');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
    // CSS opacity compounds on nesting (two 0.55s render at ~0.30), so the PluginHeader root
    // inside this dimmed <th> must not carry a second opacity.
    const pluginHeaderRoot = th!.querySelector(':scope > div');
    expect((pluginHeaderRoot as HTMLElement).style.opacity).toBe('');
  });

  it('does not dim a vanilla-master column (immutable, still in the load order)', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Fallout4.esm')).toBeInTheDocument());

    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    const th = screen.getByText('Fallout4.esm').closest('th');
    expect(th).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });
});

describe('RecordPanel — a Partial Form column', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column header dimmed, matching xEdit-style marking rather than a full competing override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    const th = screen.getByText('MyMod.esp').closest('th');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  // One dimmed set reaches the header and every cell under it: a header-only rule would leave the
  // column's own cells at full weight once the non-sticky header scrolls away.
  it('renders every cell of that column dimmed too', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());

    const cells = screen.getByText('Name').closest('tr')!.querySelectorAll('td');
    expect(cells[2]).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
    expect(cells[1]).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  // The panel resolves every row's schema leaf itself, so a diff naming a member no override
  // declares has no shape to render against and neither it nor its subtree appears.
  it('drops a diff node naming a member no override\'s schema declares', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel({
      ...compareResult,
      diffs: [...compareResult.diffs, {
        fieldName: 'Undeclared', values: { 'MyMod.esp': 'x' }, winnerColumn: 'MyMod.esp',
cellStates: {}, conflictAll: 'NoConflict',
      }],
    });
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
    expect(screen.queryByText('Undeclared')).not.toBeInTheDocument();
  });
});

describe('RecordPanel — Partial Form header toggle', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  // The flag is the annotated synthetic member `IsPartialForm`, written through the one envelope.
  it('unchecking the checkbox posts set of IsPartialForm to false', async () => {
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(screen.getByRole('checkbox'));

    // origin deliberately unasserted: this fixture's MyMod.esp override omits it.
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'IsPartialForm' }], value: false },
    }));
  });
});

// Drives the gesture through the real editableColumns computation rather than a hand-fed set,
// with a scalar cell and a flags cell on the identical column so only the field type differs.
describe('RecordPanel — flags cell editing through real message plumbing', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  // The control: a scalar edit on the identical tracked, editable column the flags cases use.
  it('control: a scalar cell in a tracked, editable column opens an editable input on double click', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Override Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  // A flags row starts collapsed to its compact summary; the chevron reveals the checkbox list,
  // enabled only in the tracked, editable column.
  it('a flags row starts collapsed; expanding reveals enabled checkboxes and it re-collapses', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    // compact summary, value 3, once per column
    await waitFor(() => expect(screen.getAllByText('A, B')).toHaveLength(2));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    // The immutable master column's flags expand too, its checkboxes disabled.
    const enabled = screen.getAllByRole('checkbox').filter(b => !(b as HTMLInputElement).disabled);
    expect(enabled).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '▼' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getAllByText('A, B')).toHaveLength(2);
  });

  it('toggling a flag posts set of the member with the names now set', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getAllByText('A, B')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    vi.mocked(vscode.postMessage).mockClear();

    // uncheck A in the tracked column — the first *enabled* box, since the master column's
    // disabled checkboxes render first in column order.
    fireEvent.click(screen.getAllByRole('checkbox').filter(b => !(b as HTMLInputElement).disabled)[0]);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Flags' }], value: ['B'] },
    }));
  });
});

describe('RecordPanel — conflict color coding', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Each field's own diffs[].conflictAll drives its own row, never the record-wide
  // CompareResult.conflictAll smeared onto every row.
  it('applies green row background to a field whose own conflictAll is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr')!;
    expect(row.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });

  it('applies orange row background to a field whose own conflictAll is Conflict', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr')!;
    expect(row.style.backgroundColor).toBe('rgba(255, 152, 0, 0.20)');
  });

  // Two sibling fields, only one differing: a record-wide smear would tint both rows alike.
  it('colors only the field that actually differs — an agreeing sibling row gets no background', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(twoSiblingFieldsResult);
    await waitFor(() => screen.getByText('Name'));
    const nameRow = screen.getByText('Name').closest('tr')!;
    const levelRow = screen.getByText('Level').closest('tr')!;
    expect(nameRow.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
    expect(levelRow.style.backgroundColor).toBe('');
  });

  it('applies orange cell background when cellStates is ConflictWins', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(255, 152, 0, 0.18)');
  });

  it('applies green cell background when cellStates is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(76, 175, 80, 0.18)');
  });

  it('column header background reflects CompareOverride.conflictThis', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    // MyMod.esp header: conflictThis = 'ConflictWins' → orange background in the <th>
    const header = screen.getByText('MyMod.esp').closest('th')!;
    expect(header.style.backgroundColor).toBe('rgba(255, 152, 0, 0.35)');
  });
});

describe('RecordPanel — postMessage wiring', () => {
  const fkPlugins = [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }];

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });

  it('calls vscode.postMessage with type openRecord when a FormKey link is Ctrl+clicked', async () => {
    renderPanel(fkCompareResult, { plugins: fkPlugins });
    // Labelled with the "EditorID [FormKey]" composite, so the reference is identifiable from
    // the cell alone rather than only by its EditorID.
    await waitFor(() => screen.getByText('HumanRace [00013918:Fallout4.esm]'));
    fireEvent.click(screen.getByText('HumanRace [00013918:Fallout4.esm]'), { ctrlKey: true });
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.OPEN_RECORD,
      formKey: '00013918:Fallout4.esm',
    });
  });

  it('re-loads with the new formKey when a loadRecord message arrives from the extension', async () => {
    const { client } = renderPanel(fkCompareResult, { plugins: fkPlugins });
    await waitFor(() => screen.getByText('TestNPC [000001:Fallout4.esm]'));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(client.load).toHaveBeenCalledWith('000002:Fallout4.esm'));
  });
});

describe('RecordPanel — struct sub-rows', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('struct parent row renders ▶ toggle and {…} placeholder in value cells', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('Bounds'));
    expect(screen.getByText('▶')).toBeInTheDocument();
    expect(screen.getAllByText('{…}').length).toBeGreaterThan(0);
  });

  it('child rows appear after clicking ▶ toggle', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => expect(screen.getByText('X')).toBeInTheDocument());
    expect(screen.getByText('Y')).toBeInTheDocument();
  });

  // The master's X: 10 beside the override's X: 15 — the delta struct expansion exists to show.
  it('child row for X shows each override\'s own sub-field value', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('toggle collapses child rows when clicked again', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));
    fireEvent.click(screen.getByText('▼'));
    await waitFor(() => expect(screen.queryByText('X')).not.toBeInTheDocument());
  });

  it('child row X has correct cell background from cellStates (Override = green)', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('15'));
    const cell = screen.getByText('15').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(76, 175, 80, 0.18)');
  });
});

describe('RecordPanel — incomplete-comparison banner (ADR-0013)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('states the comparison is incomplete when opened while the winner sweep is outstanding (AC1)', async () => {
    renderPanel(compareResult, { conflictsComputed: false });
    await waitFor(() => screen.getByText(recordPanelIncompleteMessage(false)!));
  });

  it('shows no statement once the sweep has already completed (AC3)', async () => {
    renderPanel(compareResult, { conflictsComputed: true });
    await waitFor(() => screen.getByText(/TestNPC/));
    expect(screen.queryByText(recordPanelIncompleteMessage(false)!)).not.toBeInTheDocument();
  });

  // A panel already open when the sweep lands must reflect the settled data, not just clear its
  // banner over stale content.
  it('refetches and reflects settled data when CONFLICTS_COMPUTED arrives (AC4)', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        immutableSet: new Set(), notInLoadOrderSet: new Set(), conflictsComputed: false,
      })
      .mockResolvedValue({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        immutableSet: new Set(), notInLoadOrderSet: new Set(), conflictsComputed: true,
      });
    renderPanel(compareResult, { load });
    await waitFor(() => screen.getByText(recordPanelIncompleteMessage(false)!));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED } }));
    });

    await waitFor(() => expect(screen.queryByText(recordPanelIncompleteMessage(false)!)).not.toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(2);
  });

  // A panel this message reaches before it has loaded any record must not throw or fetch.
  it('does nothing when CONFLICTS_COMPUTED arrives before any record is loaded', () => {
    vi.stubGlobal('mEditFormKey', '');
    const load = vi.fn();
    renderPanel(compareResult, { load });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: EXTENSION_TO_WEBVIEW.CONFLICTS_COMPUTED } }));
    });

    expect(load).not.toHaveBeenCalled();
  });
});

describe('RecordPanel — LOAD_RECORD state management', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('re-loads data when LOAD_RECORD arrives with the same formKey', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText(/TestNPC/));
    const callsBefore = (client.load as ReturnType<typeof vi.fn>).mock.calls.length;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect((client.load as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => screen.getByText(/TestNPC/));
  });

  it('clears error and shows data after a successful refresh following a load failure', async () => {
    // First load fails; the LOAD_RECORD-driven reload succeeds.
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 500' })
      .mockResolvedValue({
        ok: true, result: compareResult, changes: [], plugins: pluginsResponse,
        immutableSet: new Set(['Fallout4.esm']), conflictsComputed: true,
      });
    renderPanel(compareResult, { load });
    await waitFor(() => expect(screen.getByText(/Error:/)).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(screen.queryByText(/Error:/)).not.toBeInTheDocument());
    await waitFor(() => screen.getByText(/TestNPC/));
  });
});

describe('RecordPanel — column collapse (issue #3)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  it('clicking a plugin column header chip collapses that column, hiding its field values', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    // the chip itself stays visible
    expect(screen.getByText('MyMod.esp')).toBeInTheDocument();
  });

  it('clicking a collapsed column chip again expands it', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('collapsed column header hides the (read-only) label', async () => {
    renderPanel(immutableWinnerCompareResult, { plugins: pluginsResponse });
    await waitFor(() => screen.getByText('(read-only)'));
    expect(screen.getByText('(read-only)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
  });

  it('collapsed state survives a LOAD_RECORD navigation to a different formKey', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => screen.getByText('MyMod.esp'));
    // Still collapsed after navigating to a new record in the same panel load order.
    expect(screen.queryByText('Override Name')).not.toBeInTheDocument();
  });
});

// Two plugins can disagree on which leaf of an abstract union an element is, so the element's
// rows are both leaves' members. A member's `variants`, read through the element's discriminator,
// name the leaves declaring it.
const intSubMeta = (name: string): FieldMetadata =>
  (fieldMeta({ name, type: 'int' }));

const aliasSubMeta = (name: string, leaf: string): FieldMetadata => fieldMeta({
  name, type: 'struct', fields: [intSubMeta('alias_id')],
  variants: { [leaf]: fieldMeta({ name, type: 'struct', fields: [intSubMeta('alias_id')] }) }});

const aliasesMeta: FieldMetadata = fieldMeta({
  name: 'aliases', type: 'array', isArray: true,
  elementType: fieldMeta({
    name: '', type: 'struct',
    fields: [
      fieldMeta({ name: 'Kind', type: 'string', isDiscriminator: true }),
      fieldMeta({ name: 'name', type: 'string' }),
      aliasSubMeta('location', 'RefAlias'),
      aliasSubMeta('external', 'LocAlias'),
    ]})});

const masterAlias = { Kind: 'RefAlias', name: 'AnAlias', location: { alias_id: 5 }, external: null };
const overrideAlias = { Kind: 'LocAlias', name: 'AnAlias', location: null, external: { alias_id: 7 } };

const mixedLeafAliasResult = {
  conflictAll: 'Conflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestQuest', fields: [{ metadata: aliasesMeta, value: [masterAlias] }], conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestQuest', fields: [{ metadata: aliasesMeta, value: [overrideAlias] }], conflictThis: 'ConflictWins',
    },
  ],
  diffs: [{
    fieldName: 'aliases',
    values: { 'Fallout4.esm': [masterAlias], 'MyMod.esp': [overrideAlias] },
    winnerColumn: 'MyMod.esp', cellStates: {},
    children: [{
      fieldName: '[0]',
      values: { 'Fallout4.esm': masterAlias, 'MyMod.esp': overrideAlias },
      winnerColumn: 'MyMod.esp', cellStates: {},
      children: [
        {
          fieldName: 'name', values: { 'Fallout4.esm': 'AnAlias', 'MyMod.esp': 'AnAlias' },
          winnerColumn: 'MyMod.esp', cellStates: {},
        },
        {
          fieldName: 'location',
          values: { 'Fallout4.esm': { alias_id: 5 }, 'MyMod.esp': null },
          winnerColumn: 'Fallout4.esm', cellStates: {},
          children: [{
            fieldName: 'alias_id', values: { 'Fallout4.esm': 5, 'MyMod.esp': null },
            winnerColumn: 'Fallout4.esm', cellStates: {},
          }],
        },
        {
          fieldName: 'external',
          values: { 'Fallout4.esm': null, 'MyMod.esp': { alias_id: 7 } },
          winnerColumn: 'MyMod.esp', cellStates: {},
          children: [{
            fieldName: 'alias_id', values: { 'Fallout4.esm': null, 'MyMod.esp': 7 },
            winnerColumn: 'MyMod.esp', cellStates: {},
          }],
        },
      ],
    }],
  }],
};

// Both plugins carry the same leaf, and the backend drops a member null in every column, so
// only that leaf's members remain.
const singleLeafAliasResult = {
  ...mixedLeafAliasResult,
  overrides: mixedLeafAliasResult.overrides.map(o => ({ ...o, fields: [{ metadata: aliasesMeta, value: [masterAlias] }] })),
  diffs: [{
    ...mixedLeafAliasResult.diffs[0],
    values: { 'Fallout4.esm': [masterAlias], 'MyMod.esp': [masterAlias] },
    children: [{
      ...mixedLeafAliasResult.diffs[0].children[0],
      values: { 'Fallout4.esm': masterAlias, 'MyMod.esp': masterAlias },
      children: mixedLeafAliasResult.diffs[0].children[0].children
        .filter(c => c.fieldName !== 'external')
        .map(c => (c.fieldName === 'location'
          ? { ...c, values: { 'Fallout4.esm': { alias_id: 5 }, 'MyMod.esp': { alias_id: 5 } } }
          : c)),
    }],
  }],
};

describe('RecordPanel — union element rows', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Scoped to the grid's own body — the column headers carry their own load-order index, so
  // "[0]" is not unique document-wide.
  const rows = () => within(screen.getByRole('table').querySelector('tbody')!);

  function labelCell(label: string): HTMLElement {
    return rows().getByText(label).closest('td')!;
  }

  function expandRow(label: string) {
    fireEvent.click(labelCell(label).querySelector('button')!);
  }

  async function renderExpandedElement() {
    renderPanel(mixedLeafAliasResult);
    await waitFor(() => rows().getByText('aliases'));
    expandRow('aliases');
    await waitFor(() => rows().getByText('[0]'));
    expandRow('[0]');
    await waitFor(() => rows().getByText('location'));
  }

  it('shows the union of both plugins\' leaf members', async () => {
    await renderExpandedElement();
    expect(rows().getByText('name')).toBeInTheDocument();
    expect(rows().getByText('location')).toBeInTheDocument();
    expect(rows().getByText('external')).toBeInTheDocument();
  });

  it('renders an empty cell for the column whose leaf lacks the member', async () => {
    await renderExpandedElement();
    const locationCells = labelCell('location').closest('tr')!.querySelectorAll('td');
    expect(locationCells[1].textContent).toBe('{…}');
    expect(locationCells[2].textContent).toBe('');

    const externalCells = labelCell('external').closest('tr')!.querySelectorAll('td');
    expect(externalCells[1].textContent).toBe('');
    expect(externalCells[2].textContent).toBe('{…}');
  });

  // An element's rows are the ones its own plugins carry, never one per schema member: the
  // other leaves' members are null in every column and never reach the webview.
  it('shows no row for a member no plugin\'s leaf declares', async () => {
    renderPanel(singleLeafAliasResult);
    await waitFor(() => rows().getByText('aliases'));
    expandRow('aliases');
    await waitFor(() => rows().getByText('[0]'));
    expandRow('[0]');
    await waitFor(() => rows().getByText('location'));
    expect(rows().queryByText('external')).not.toBeInTheDocument();
  });

  it('indents each nesting level by its own depth', async () => {
    await renderExpandedElement();
    expect(labelCell('aliases')).not.toHaveStyle({ paddingLeft: '24px' });
    expect(labelCell('[0]')).toHaveStyle({ paddingLeft: '24px' });
    expect(labelCell('location')).toHaveStyle({ paddingLeft: '48px' });

    expandRow('location');
    await waitFor(() => rows().getByText('alias_id'));
    expect(labelCell('alias_id')).toHaveStyle({ paddingLeft: '72px' });
  });
});

// A Mutagen class name is a wire token the user is never shown, so the panel displays the
// reflector's labels and posts the values.
const unionFieldMeta: FieldMetadata = fieldMeta({
  name: 'Level',
  type: 'struct',
  fields: [
    fieldMeta({ name: 'level', type: 'int' }),
    fieldMeta({
      name: 'MutagenObjectType', type: 'enum',
      enumMembers: [{ value: 'NpcLevel', label: 'Npc Level' },
        { value: 'PcLevelMult', label: 'Pc Level Mult' }],
      displayLabel: 'Kind'}),
  ]});

const unionValue = { level: 5, MutagenObjectType: 'NpcLevel' };

const unionCompareResult = {
  conflictAll: 'OnlyOne',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: unionFieldMeta, value: unionValue }],
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Level',
      values: { 'MyMod.esp': unionValue },
      winnerColumn: 'MyMod.esp', cellStates: {},
      children: [
        {
          fieldName: 'level', values: { 'MyMod.esp': 5 },
          winnerColumn: 'MyMod.esp', cellStates: {},
        },
        {
          fieldName: 'MutagenObjectType', values: { 'MyMod.esp': 'NpcLevel' },
          winnerColumn: 'MyMod.esp', cellStates: {},
        },
      ],
    },
  ],
};

const unionTrackedPluginsResponse = [
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true },
];

describe('RecordPanel — an abstract union\'s leaf is an editable field', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  async function expandLevel() {
    renderPanel(unionCompareResult, { plugins: unionTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('Level')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    await waitFor(() => expect(screen.getByText('Kind')).toBeInTheDocument());
  }

  it('labels the row from the schema and never shows the class name it holds', async () => {
    await expandLevel();

    expect(screen.queryByText('MutagenObjectType')).not.toBeInTheDocument();
    expect(screen.getByText('Npc Level')).toBeInTheDocument();
    expect(screen.queryByText('NpcLevel')).not.toBeInTheDocument();
  });

  it('opens a dropdown of the union\'s leaves, listed by label', async () => {
    await expandLevel();

    fireEvent.doubleClick(screen.getByText('Npc Level'));

    const options = within(screen.getByRole('combobox')).getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['Npc Level', 'Pc Level Mult']);
  });

  // A discriminator switch is the Kind row's own set; the backend switches the leaf.
  it('posts set of the discriminator member carrying the chosen leaf\'s own wire value, not its label', async () => {
    await expandLevel();
    fireEvent.doubleClick(screen.getByText('Npc Level'));
    vi.mocked(vscode.postMessage).mockClear();

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'PcLevelMult' } });
    fireEvent.blur(select);

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      envelope: {
        op: 'set',
        path: [{ kind: 'member', name: 'Level' }, { kind: 'member', name: 'MutagenObjectType' }],
        value: 'PcLevelMult',
      },
    }));
  });
});

// Absent means default (ADR-0005): the document omits a member equal to its default, and the grid
// reads it back as that default. "—" is kept for a member whose metadata says null is a value.
describe('RecordPanel — an absent member reads as its default', () => {
  const statsMeta: FieldMetadata = fieldMeta({
    name: 'Stats', type: 'struct',
    fields: [
      fieldMeta({ name: 'Weight', type: 'int' }),
      fieldMeta({ name: 'Essential', type: 'bool' }),
      fieldMeta({ name: 'Prefix', type: 'string' }),
      fieldMeta({
        name: 'RunOn', type: 'enum', default: 'Subject',
        enumMembers: [{ value: 'Subject' }, { value: 'Target' }]}),
      fieldMeta({ name: 'Count', type: 'int', default: 100 }),
      fieldMeta({ name: 'Owner', type: 'formKey', validFormKeyTypes: ['NPC_'], allowsNull: true }),
    ]});
  const full = { Weight: 3, Essential: true, Prefix: 'x', RunOn: 'Target', Count: 7, Owner: '000019:Fallout4.esm' };
  const sparse = {};

  const compare = {
    conflictAll: 'Conflict',
    overrides: [
      { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
        editorId: 'TestNPC', fields: [{ metadata: statsMeta, value: full }], conflictThis: 'Master' },
      { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
        editorId: 'TestNPC', fields: [{ metadata: statsMeta, value: sparse }], conflictThis: 'ConflictWins' },
    ],
    diffs: [{
      fieldName: 'Stats', values: { 'Fallout4.esm': full, 'MyMod.esp': sparse },
      winnerColumn: 'MyMod.esp', cellStates: {},
      children: Object.entries(full).map(([name, v]) => ({
        fieldName: name, values: { 'Fallout4.esm': v, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
      })),
    }],
  };

  const rows = () => within(screen.getByRole('table').querySelector('tbody')!);
  const cellsOf = (label: string) => rows().getByText(label).closest('tr')!.querySelectorAll('td');

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function renderExpanded() {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Stats'));
    fireEvent.click(rows().getByText('Stats').closest('td')!.querySelector('button')!);
    await waitFor(() => rows().getByText('Weight'));
  }

  it('an absent int reads 0, an absent bool false, an absent string empty', async () => {
    await renderExpanded();
    expect(cellsOf('Weight')[2].textContent).toBe('0');
    expect(cellsOf('Essential')[2].textContent).toBe('false');
    expect(cellsOf('Prefix')[2].textContent).toBe('');
    expect(rows().queryAllByText('—')).toHaveLength(1);
  });

  it('an absent enum reads the default the metadata names', async () => {
    await renderExpanded();
    expect(cellsOf('RunOn')[2].textContent).toBe('Subject');
  });

  it('an absent scalar with a declared default reads that default', async () => {
    await renderExpanded();
    expect(cellsOf('Count')[2].textContent).toBe('100');
  });

  it('an unset nullable link reads as empty', async () => {
    await renderExpanded();
    expect(cellsOf('Owner')[2].textContent).toBe('—');
  });

  // The default is what the editor opens on, so a value equal to it is no edit at all.
  it('editing an absent int from its default posts one set with the typed value', async () => {
    await renderExpanded();
    vi.mocked(vscode.postMessage).mockClear();
    const cell = cellsOf('Weight')[2] as HTMLElement;
    fireEvent.doubleClick(within(cell).getByText('0'));
    const input = cell.querySelector('input')!;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Stats' }, { kind: 'member', name: 'Weight' }], value: 5 },
    }));
  });
});

// A member whose owner is not there in a column is not absent-by-default: there is nothing for it
// to be a member of, so it reads as nothing, not as zero.
describe('RecordPanel — a member of an absent owner reads as nothing', () => {
  const boundsMeta: FieldMetadata = fieldMeta({
    name: 'Bounds', type: 'struct', allowsNull: true,
    fields: [fieldMeta({ name: 'X', type: 'int' })]});
  const valuesMeta: FieldMetadata = fieldMeta({
    name: 'Values', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'int' })});
  const compare = {
    conflictAll: 'Conflict',
    overrides: [
      { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: boundsMeta, value: { X: 10 } }, { metadata: valuesMeta, value: [1, 2] }], conflictThis: 'Master' },
      { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: boundsMeta, value: null }, { metadata: valuesMeta, value: [1] }], conflictThis: 'ConflictWins' },
    ],
    diffs: [
      {
        fieldName: 'Bounds', values: { 'Fallout4.esm': { X: 10 }, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
        children: [{ fieldName: 'X', values: { 'Fallout4.esm': 10, 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {} }],
      },
      {
        fieldName: 'Values', values: { 'Fallout4.esm': [1, 2], 'MyMod.esp': [1] },
        winnerColumn: 'MyMod.esp', cellStates: {},
        children: [
          { fieldName: '[0]', values: { 'Fallout4.esm': 1, 'MyMod.esp': 1 }, winnerColumn: 'MyMod.esp', cellStates: {} },
          { fieldName: '[1]', values: { 'Fallout4.esm': 2, 'MyMod.esp': null }, winnerColumn: 'Fallout4.esm', cellStates: {} },
        ],
      },
    ],
  };

  const rows = () => within(screen.getByRole('table').querySelector('tbody')!);
  const cellsOf = (label: string) => rows().getByText(label).closest('tr')!.querySelectorAll('td');

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('an unset nullable struct reads as empty, and its member as nothing rather than zero', async () => {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Bounds'));
    expect(cellsOf('Bounds')[2].textContent).toBe('');
    fireEvent.click(rows().getByText('Bounds').closest('td')!.querySelector('button')!);
    await waitFor(() => rows().getByText('X'));

    expect(cellsOf('X')[1].textContent).toBe('10');
    expect(cellsOf('X')[2].textContent).toBe('');
  });

  it('an element past the column\'s own length reads as nothing, not zero', async () => {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Values'));
    fireEvent.click(rows().getByText('Values').closest('td')!.querySelector('button')!);
    await waitFor(() => rows().getByText('[1]'));

    expect(cellsOf('[1]')[1].textContent).toBe('2');
    expect(cellsOf('[1]')[2].textContent).toBe('');
  });

  // The classifier nulls every field of a Partial Form column: none of them is absent-by-default.
  it('a Partial Form column\'s fields read as nothing', async () => {
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Name'));
    expect(cellsOf('Name')[1].textContent).toBe('Original Name');
    expect(cellsOf('Name')[2].textContent).toBe('');
  });

  // A non-nullable struct is the field whose absence would otherwise read as its default.
  it('a Partial Form column\'s non-nullable struct field reads as nothing, not as its default', async () => {
    const sizeMeta: FieldMetadata = fieldMeta({
      name: 'Size', type: 'struct', fields: [fieldMeta({ name: 'Width', type: 'int' })]});
    renderPanel({
      ...partialFormCompareResult,
      overrides: partialFormCompareResult.overrides.map((o, i) => ({
        ...o, fields: [{ metadata: sizeMeta, value: i === 0 ? { Width: 3 } : null }],
      })),
      diffs: [{
        fieldName: 'Size', values: { 'Fallout4.esm': { Width: 3 }, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
        children: [{
          fieldName: 'Width', values: { 'Fallout4.esm': 3, 'MyMod.esp': null },
          winnerColumn: 'Fallout4.esm', cellStates: {},
        }],
      }],
    }, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Size'));
    expect(cellsOf('Size')[1].textContent).toBe('{…}');
    expect(cellsOf('Size')[2].textContent).toBe('');

    fireEvent.click(rows().getByText('Size').closest('td')!.querySelector('button')!);
    await waitFor(() => rows().getByText('Width'));
    expect(cellsOf('Width')[2].textContent).toBe('');
  });
});

// ADR-0005: absent means default. A non-nullable struct has no "unset", so the column that omits
// it holds that struct at its defaults, member by member.
describe('RecordPanel — an absent non-nullable struct reads as its default members', () => {
  const sizeMeta: FieldMetadata = fieldMeta({
    name: 'Size', type: 'struct',
    fields: [
      fieldMeta({ name: 'Width', type: 'int' }),
      fieldMeta({ name: 'Label', type: 'string' }),
      fieldMeta({ name: 'Depth', type: 'int', default: 12 }),
    ]});
  const full = { Width: 3, Label: 'x', Depth: 7 };
  const compare = {
    conflictAll: 'Conflict',
    overrides: [
      { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: sizeMeta, value: full }], conflictThis: 'Master' },
      { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: sizeMeta, value: null }], conflictThis: 'ConflictWins' },
    ],
    diffs: [{
      fieldName: 'Size', values: { 'Fallout4.esm': full, 'MyMod.esp': null },
      winnerColumn: 'Fallout4.esm', cellStates: {},
      children: Object.entries(full).map(([name, v]) => ({
        fieldName: name, values: { 'Fallout4.esm': v, 'MyMod.esp': null },
        winnerColumn: 'Fallout4.esm', cellStates: {},
      })),
    }],
  };

  const rows = () => within(screen.getByRole('table').querySelector('tbody')!);
  const cellsOf = (label: string) => rows().getByText(label).closest('tr')!.querySelectorAll('td');

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function renderCollapsed() {
    renderPanel(compare, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => rows().getByText('Size'));
  }

  async function renderExpanded() {
    await renderCollapsed();
    fireEvent.click(rows().getByText('Size').closest('td')!.querySelector('button')!);
    await waitFor(() => rows().getByText('Width'));
  }

  it('the struct the column omits reads as a struct, not as nothing', async () => {
    await renderCollapsed();
    expect(cellsOf('Size')[2].textContent).toBe('{…}');
  });

  it('each member of the omitted struct reads its own default', async () => {
    await renderExpanded();
    expect(cellsOf('Width')[2].textContent).toBe('0');
    expect(cellsOf('Label')[2].textContent).toBe('');
    expect(cellsOf('Depth')[2].textContent).toBe('12');
  });
});

// A translated string is one leaf whose document spelling is an object; its set carries that
// object, so the codec receives what it wrote.
describe('RecordPanel — a translated string leaf posts its object', () => {
  const nameMeta: FieldMetadata = fieldMeta({ name: 'Name', type: 'translatedString' });
  const value = { TargetLanguage: 'English', Value: 'Base name' };
  const compare = {
    conflictAll: 'OnlyOne',
    overrides: [{ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: nameMeta, value }], conflictThis: 'OnlyOne' }],
    diffs: [{ fieldName: 'Name', values: { 'MyMod.esp': value }, winnerColumn: 'MyMod.esp', cellStates: {} }],
  };

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('reads the text and posts set of the whole object with the new Value', async () => {
    renderPanel(compare, { plugins: unionTrackedPluginsResponse });
    await waitFor(() => screen.getByText('Base name'));
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.doubleClick(screen.getByText('Base name'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      envelope: { op: 'set', path: [{ kind: 'member', name: 'Name' }], value: { TargetLanguage: 'English', Value: 'New name' } },
    }));
  });
});


// A record Mutagen could not read stays in the grid rather than vanishing, showing what was
// stored and offering nothing that writes. Both columns here are tracked and mutable, so only
// the diagnosis can explain a read-only cell.
describe('RecordPanel — a column whose record failed to parse', () => {
  const PARSE_DIAGNOSIS = 'the PERK entry point did not have expected parameter type flag';

  const keywordsMeta: FieldMetadata = fieldMeta({
    name: 'Keywords', type: 'array', isArray: true,
    elementType: fieldMeta({ name: '', type: 'string' }),
  });

  const column = (plugin: string, name: string, parseDiagnosis?: string) => ({
    formKey: '000001:Broken.esp', plugin, loadOrderIndex: plugin === 'Broken.esp' ? 0 : 1,
    isWinner: plugin !== 'Broken.esp', editorId: 'TestNPC',
    fields: [{ metadata: strMeta, value: name }, { metadata: keywordsMeta, value: ['KwdA'] }],
    conflictThis: 'Master', parseDiagnosis,
  });

  const compare = {
    conflictAll: 'Conflict',
    overrides: [column('Broken.esp', 'Stored Name', PARSE_DIAGNOSIS), column('Good.esp', 'Readable Name')],
    diffs: [
      {
        fieldName: 'Name', values: { 'Broken.esp': 'Stored Name', 'Good.esp': 'Readable Name' },
        winnerColumn: 'Good.esp', cellStates: {}, conflictAll: 'Conflict',
      },
      {
        fieldName: 'Keywords', values: { 'Broken.esp': ['KwdA'], 'Good.esp': ['KwdA'] },
        winnerColumn: 'Good.esp', cellStates: {}, conflictAll: 'NoConflict',
        children: [{
          fieldName: 'KwdA', values: { 'Broken.esp': 'KwdA', 'Good.esp': 'KwdA' },
          winnerColumn: 'Good.esp', cellStates: {},
        }],
      },
    ],
  };

  const plugins = [
    { name: 'Broken.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true },
    { name: 'Good.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
  ];

  const contextsFor = (container: HTMLElement, plugin: string) =>
    Array.from(container.querySelectorAll('[data-vscode-context]'))
      .map((e): Record<string, unknown> => JSON.parse(e.getAttribute('data-vscode-context') ?? ''))
      .filter(c => c.plugin === plugin);

  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Broken.esp'));
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column from its stored document rather than dropping it', async () => {
    renderPanel(compare, { plugins });

    await waitFor(() => expect(screen.getByText('Broken.esp')).toBeInTheDocument());
    expect(screen.getByText('Stored Name')).toBeInTheDocument();
  });

  it('opens no editor on its cells, where the readable column opens one', async () => {
    renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    fireEvent.doubleClick(screen.getByText('Stored Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('Readable Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  // The array gestures are host commands gated on the row's own data-vscode-context, so a column
  // that offers no array section offers no Add/Remove/Move at all.
  it('offers no array right-click commands, where the readable column offers them', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    const arraySections = (plugin: string) => contextsFor(container, plugin)
      .map(c => String(c.webviewSection)).filter(s => s.includes('array'));
    expect(arraySections('Broken.esp')).toEqual([]);
    expect(arraySections('Good.esp')).not.toEqual([]);
  });

  // ADR-0018 keeps Open in Editor… on a read-only column — it is the only way to read a long
  // value in full — so what has to be pinned is that it cannot write.
  it('marks the extended editor read-only on its string cells, where the readable column does not', async () => {
    const { container } = renderPanel(compare, { plugins });
    await waitFor(() => screen.getByText('Stored Name'));

    const stringContext = (plugin: string) => contextsFor(container, plugin)
      .find(c => String(c.webviewSection).includes('stringValue'));
    expect(stringContext('Broken.esp')?.readOnly).toBe(true);
    expect(stringContext('Good.esp')?.readOnly).toBe(false);
  });
});
