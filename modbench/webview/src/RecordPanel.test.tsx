import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import { recordPanelIncompleteMessage } from '../../src/medit/loadOrderProgress';
import { DIMMED_OPACITY } from './gridStyles';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordPanelClient } from './RecordPanelClient';

// ── shared metadata fixtures ──────────────────────────────────────────────────

const strMeta: FieldMetadata = { name: 'Name', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };

// ── RecordPanel ───────────────────────────────────────────────────────────────

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
      winnerValue: 'Override Name',
      cellStates: { 'MyMod.esp': 'ConflictWins' },
      conflictAll: 'Conflict',
    },
  ],
};

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

// ── fixtures for the read-path suites ─────────────────────────────────────────

const intMeta: FieldMetadata = { name: 'Level', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] };
const fkMeta: FieldMetadata = {
  name: 'Race', type: 'formKey', isArray: false, validFormKeyTypes: ['race'], enumValues: [],
};

const threePluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'Mod1.esp', isImmutable: false, loadOrderIndex: 1 },
  { name: 'Mod2.esp', isImmutable: false, loadOrderIndex: 2 },
];

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
      winnerValue: '00013918:Fallout4.esm',
      cellStates: {},
      // ADR-0031: the backend carries a resolution signal per FormKey value — this fixture
      // mirrors a resolved reference so the Ctrl-hover affordance/navigation tests below exercise
      // real product behavior instead of an unresolved default.
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
    winnerColumn: 'MyMod.esp', winnerValue: 'Override Name', cellStates: { 'MyMod.esp': 'Override' },
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
      winnerColumn: 'MyMod.esp', winnerValue: 'Override Name', cellStates: { 'MyMod.esp': 'Override' },
      conflictAll: 'Override' },
    { fieldName: 'Level', values: { 'Fallout4.esm': 5, 'MyMod.esp': 5 },
      winnerColumn: 'MyMod.esp', winnerValue: 5, cellStates: {},
      conflictAll: 'NoConflict' },
  ],
};

const threePluginConflictResult = {
  conflictAll: 'Conflict',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Alice' }], conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'Mod1.esp', origin: 'Data', loadOrderIndex: 1, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Bob' }], conflictThis: 'ConflictLoses', recordType: 'npc_' },
    { formKey: '000001:Fallout4.esm', plugin: 'Mod2.esp', origin: 'Data', loadOrderIndex: 2, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Charlie' }], conflictThis: 'ConflictWins' },
  ],
  diffs: [{
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'Alice', 'Mod1.esp': 'Bob', 'Mod2.esp': 'Charlie' },
    winnerColumn: 'Mod2.esp',
    winnerValue: 'Charlie',
    cellStates: { 'Mod1.esp': 'ConflictLoses', 'Mod2.esp': 'ConflictWins' },
  }],
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
    winnerValue: 'FromB',
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
    winnerValue: 'Shadowed value',
    cellStates: { [columnKey('Solo.esp', 'ShadowMod')]: 'OnlyOne' },
  }],
};

const notInLoadOrderPluginsResponse = [
  { name: 'Solo.esp', origin: 'ShadowMod', isImmutable: true, loadOrderIndex: 5, inLoadOrder: false },
];

// Mirrors pluginsResponse, but MyMod.esp is tracked — the Partial Form toggle is disabled
// on an untracked column (canWrite), so exercising the real dispatch needs a column that can
// actually write.
const partialFormTrackedPluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
];

// Mirrors compareResult, but MyMod.esp is a Partial Form override of the master rather than
// an ordinary conflicting one.
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
      winnerColumn: 'Fallout4.esm', winnerValue: 'Original Name',
      cellStates: {},
    },
  ],
};

// #622: a bitmask 'enum' field alongside an ordinary scalar field on the same tracked,
// editable column — the exact contrast the issue reports (scalar/FormKey edits worked in the
// same session, flags did not). enumBitValues aligned with enumValues per FlagCell's own
// contract; value '3' (0b11) sets both A and B so the resting label reads "A, B".
const flagsFieldMeta: FieldMetadata = {
  name: 'Flags', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumValues: ['A', 'B'], enumBitValues: ['1', '2'], isBitmask: true,
};

const flagsCompareResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Original Name' },
        { metadata: flagsFieldMeta, value: '3' },
      ],
      conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC',
      fields: [
        { metadata: strMeta, value: 'Override Name' },
        { metadata: flagsFieldMeta, value: '3' },
      ],
      conflictThis: 'IdenticalToMaster',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerColumn: 'MyMod.esp', winnerValue: 'Override Name',
      cellStates: {},
    },
    {
      fieldName: 'Flags',
      values: { 'Fallout4.esm': '3', 'MyMod.esp': '3' },
      winnerColumn: 'MyMod.esp', winnerValue: '3',
      cellStates: {},
    },
  ],
};

// Mirrors partialFormTrackedPluginsResponse — MyMod.esp must be tracked for editableColumns
// to include it at all (RecordPanel.tsx's own four-condition gate), the same real computation
// every other column-editability test in this file already relies on rather than a hand-fed set.
const flagsTrackedPluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1, isTracked: true },
];

const structFieldMeta: FieldMetadata = {
  name: 'Bounds',
  type: 'struct',
  isArray: false,
  validFormKeyTypes: [],
  enumValues: [],
  fields: [
    { name: 'X', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
    { name: 'Y', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] },
  ],
};

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
      winnerValue: { X: 15, Y: 20 },
      cellStates: { 'MyMod.esp': 'Override' },
      children: [
        {
          fieldName: 'X',
          values: { 'Fallout4.esm': 10, 'MyMod.esp': 15 },
          winnerColumn: 'MyMod.esp',
          winnerValue: 15,
          cellStates: { 'MyMod.esp': 'Override' },
        },
        {
          fieldName: 'Y',
          values: { 'Fallout4.esm': 20, 'MyMod.esp': 20 },
          winnerColumn: 'MyMod.esp',
          winnerValue: 20,
          cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        },
      ],
    },
  ],
};

const mastersMeta: FieldMetadata = {
  name: 'masters', type: 'array', isArray: true, validFormKeyTypes: [], enumValues: [],
  elementType: { name: '', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] },
};

const headerCompareResult = {
  conflictAll: 'OnlyOne',
  overrides: [
    {
      formKey: '000000:MyMod.esp',
      plugin: 'MyMod.esp',
      loadOrderIndex: 1,
      isWinner: true,
      editorId: null,
      fields: [{ metadata: mastersMeta, value: ['Fallout4.esm'] }],
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'masters',
      values: { 'MyMod.esp': ['Fallout4.esm'] },
      winnerColumn: 'MyMod.esp',
      winnerValue: ['Fallout4.esm'],
      cellStates: {},
    },
  ],
};

const headerPluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1 },
  { name: 'DLCRobot.esm', isImmutable: true, loadOrderIndex: 2 },
];

const vmadIncapableCompareResult = {
  conflictAll: 'OnlyOne',
  hasVmad: false,
  overrides: [
    {
      formKey: '000001:MyMod.esp',
      plugin: 'MyMod.esp',
      loadOrderIndex: 0,
      isWinner: true,
      editorId: 'SomeComponent',
      fields: [{ metadata: strMeta, value: 'Some Component' }],
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'MyMod.esp': 'Some Component' },
      winnerColumn: 'MyMod.esp',
      winnerValue: 'Some Component',
      cellStates: {},
    },
  ],
};

const vmadCapableCompareResult = {
  conflictAll: 'OnlyOne',
  hasVmad: true,
  overrides: [
    {
      formKey: '000001:MyMod.esp',
      plugin: 'MyMod.esp',
      loadOrderIndex: 0,
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'Test Name' }],
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'MyMod.esp': 'Test Name' },
      winnerColumn: 'MyMod.esp',
      winnerValue: 'Test Name',
      cellStates: {},
    },
  ],
};

// #622 AC: VMAD script-level flags stay read-only — even on a tracked, editable column, so
// the refusal is provably the row's own readOnly veto (vmadTreeAdapter.ts's FLAGS_META) and not
// just the column having nowhere to write. Mirrors vmadCapableCompareResult but adds a real
// script (buildVmadRows synthesizes its read-only Flags child from this) and marks the one
// column tracked, the same real editableColumns computation the #622 flags-cell block above uses.
const vmadFlagsCompareResult = {
  conflictAll: 'OnlyOne',
  hasVmad: true,
  vmad: {
    scripts: [
      { name: 'ScriptA', flags: { 'MyMod.esp': 'Local' }, winnerColumn: 'MyMod.esp', cellStates: {}, properties: [] },
    ],
  },
  overrides: [
    {
      formKey: '000001:MyMod.esp',
      plugin: 'MyMod.esp',
      loadOrderIndex: 0,
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'Test Name' }],
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'MyMod.esp': 'Test Name' },
      winnerColumn: 'MyMod.esp',
      winnerValue: 'Test Name',
      cellStates: {},
    },
  ],
};

const vmadFlagsTrackedPluginsResponse = [
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0, isTracked: true },
];



interface FakeOpts {
  plugins?: unknown[];
  // ADR-0035: defaults to true (settled, no banner) — the overwhelmingly common fixture
  // case. The two banner-specific tests below
  // override it.
  conflictsComputed?: boolean;
  load?: RecordPanelClient['load'];
  conditionRunOnTargets?: RecordPanelClient['conditionRunOnTargets'];
}

// A fake record-load order client. `load` returns the composite view built from the
// given compare fixture.
function fakeClient(compare: unknown, opts: FakeOpts = {}): RecordPanelClient {
  const pl = (opts.plugins ?? pluginsResponse) as { name: string; isImmutable: boolean; origin?: string; inLoadOrder?: boolean; isTracked?: boolean }[];
  const okLoad = {
    ok: true, result: compare, plugins: pl,
    // ADR-0036: mirrors RecordPanelClient.load()'s own columnKey()-keyed construction —
    // a fake that built this as a bare-plugin-name Set would silently pass every same-filename
    // test that exercises immutableSet, since the fake itself wouldn't reproduce the bug.
    immutableSet: new Set(pl.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin ?? null))),
    // ADR-0035: mirrors RecordPanelClient.load()'s own `=== false` filter — a fixture
    // that never sets inLoadOrder must default every column to
    // in-load-order, the same defensive default the real client applies.
    notInLoadOrderSet: new Set(pl.filter(p => p.inLoadOrder === false).map(p => columnKey(p.name, p.origin ?? null))),
    // ADR-0041: mirrors RecordPanelClient.load()'s own `=== true` filter — a
    // fixture omitting isTracked defaults every column to untracked exactly as
    // the real client's own fail-closed default does.
    trackedSet: new Set(pl.filter(p => p.isTracked === true).map(p => columnKey(p.name, p.origin ?? null))),
    conflictsComputed: opts.conflictsComputed ?? true,
  } as unknown as LoadResult;
  return {
    load: opts.load ?? vi.fn().mockResolvedValue(okLoad),
    // The Run On target dropdown's catalog — load-order-wide, fetched once on mount.
    conditionRunOnTargets: opts.conditionRunOnTargets ?? vi.fn().mockResolvedValue([]),
  };
}

function renderPanel(compare: unknown, opts: FakeOpts = {}) {
  const client = fakeClient(compare, opts);
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

  it('shows field values for each override column', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Original Name')).toBeInTheDocument());
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  // There is no edit mode. Editing affordances follow the column's plugin
  // mutability, not a mode the user has to enter on every record navigation.
  it('renders no Edit/View mode toggle', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  // Writing the binary is the separate Save & Compile
  // gesture, scoped to a whole plugin from the tree/palette, never a per-plugin control on this
  // panel (ADR-0041, medit-version-control.md).
  it('offers no per-plugin Save — writing the binary is Save & Compile, not this panel', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  // A cell in an immutable column never activates an *editable* input, however it is
  // clicked (spec: field-type rendering rule 6). ADR-0034: the cell opens no input
  // at all — nothing ever reaches a write from here.
  it('a cell in an immutable column opens nothing when clicked', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Original Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

});

// ── postMessage wiring ────────────────────────────────────────────────────────


// ADR-0036: two columns sharing a filename ('Shared.esp') but differing in origin —
// display never changes (both columns' own `.plugin` reads "Shared.esp"), so only the compound
// (plugin, origin) identity can tell them apart. The backend already returns this shape
// (ColumnKey-keyed dictionaries, per-override
// Origin) once two rows exist for one FormKey — the sameFilename fixture is that shape, built by
// hand rather than through a real reconcile.

describe('RecordPanel — same-filename, different-origin columns (#272 AC5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The genuinely red case for collapsedColumns: collapsedColumns.has(o.plugin) would
  // collide on the bare "Shared.esp" filename both columns share, so collapsing one would
  // collapse (or leave expanded) both.
  it('collapsing one column does not collapse the other same-filename column', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(sameFilenameCompareResult, { plugins: sameFilenamePluginsResponse });
    await waitFor(() => expect(screen.getByText('FromA')).toBeInTheDocument());
    expect(screen.getByText('FromB')).toBeInTheDocument();

    // A bare-text query cannot tell the two columns apart
    // (ADR-0036: origin renders inline in the header exactly when two loaded copies share a
    // filename, which this fixture does).
    const colAHeader = screen.getByText('Shared.esp (ModA)');
    fireEvent.click(colAHeader); // collapses ModA's column only

    await waitFor(() => expect(screen.queryByText('FromA')).not.toBeInTheDocument());
    expect(screen.getByText('FromB')).toBeInTheDocument();
  });

  // ADR-0036: "origin appears inline in the header only when two loaded copies share a
  // filename" — this fixture is exactly that collision, on both columns at once (neither is the
  // sole owner of the plain filename).
  it('renders origin inline in both column headers when two loaded copies share a filename', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(sameFilenameCompareResult, { plugins: sameFilenamePluginsResponse });
    await waitFor(() => expect(screen.getByText('Shared.esp (ModA)')).toBeInTheDocument());
    expect(screen.getByText('Shared.esp (ModB)')).toBeInTheDocument();
    expect(screen.queryByText('Shared.esp')).not.toBeInTheDocument();
  });

  // The single-copy control: MyMod.esp is not shared by any other column in this record's
  // response, so its header must stay the plain filename — origin inline is collision-only, not
  // "whenever origin isn't Data".
  it('does not render origin inline for a normal, non-colliding column', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());
    expect(screen.queryByText(/MyMod\.esp \(/)).not.toBeInTheDocument();
  });
});

// Copy as Override Into…/Copy as New Record Into… on the column header's
// own native right-click menu — proves the real end-to-end wiring (RecordPanel → PluginHeader),
// not just PluginHeader.test.tsx's own component-level pin, the same two-layer treatment VMAD's
// own contexts got (recordUtils.test.ts's builder test + VmadStructuralOps.test.tsx's panel test).
describe('RecordPanel — column header native right-click menu (#494)', () => {
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
        winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {},
      }],
    };
    const { container } = renderPanel(compare);
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    // Same `th > div` query the dimming test above uses — the context lives on
    // PluginHeader's own root div, nested inside RecordPanel's <th>.
    const headerRoot = container.querySelector('th > div');
    expect(JSON.parse(headerRoot!.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'ModA',
      preventDefaultContextMenuItems: true,
    });
  });
});

describe('RecordPanel — a copy the load order does not name (#304 / ADR-0035)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column header dimmed and labeled distinctly from a vanilla master', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Solo.esp');
    renderPanel(notInLoadOrderCompareResult, { plugins: notInLoadOrderPluginsResponse });
    await waitFor(() => expect(screen.getByText('Solo.esp')).toBeInTheDocument());

    expect(screen.getByText('(not loaded)')).toBeInTheDocument();
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();

    const th = screen.getByText('Solo.esp').closest('th');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
    // Dimming must apply exactly once — PluginHeader's own root <div>, nested
    // directly inside this dimmed <th>, must not carry a second opacity (CSS opacity compounds on
    // nesting, so two 0.55s would render at ~0.30, not 0.55). Real nesting, not a standalone
    // PluginHeader render, is what proves this can't silently regress.
    const pluginHeaderRoot = th!.querySelector(':scope > div');
    expect((pluginHeaderRoot as HTMLElement).style.opacity).toBe('');
  });

  it('does not dim a vanilla-master column (immutable, still in the load order)', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Fallout4.esm')).toBeInTheDocument());

    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    const th = screen.getByText('Fallout4.esm').closest('th');
    expect(th).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });
});

describe('RecordPanel — a Partial Form column (#491)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column header dimmed, matching xEdit-style marking rather than a full competing override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());

    const th = screen.getByText('MyMod.esp').closest('th');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('does not dim an ordinary column beside a Partial Form one', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(partialFormCompareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Fallout4.esm')).toBeInTheDocument());

    const th = screen.getByText('Fallout4.esm').closest('th');
    expect(th).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });
});

// The column header's own Partial Form checkbox dispatches the sanctioned is_partial_form
// write — proves the real end-to-end wiring (RecordPanel → PluginHeader → handleEditCell →
// vscode.postMessage), not just PluginHeader.test.tsx's own component-level pin of
// onTogglePartialForm, the same two-layer treatment the header right-click menu and VMAD's own
// contexts got.
describe('RecordPanel — Partial Form header toggle (#539)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('posts EDIT_FIELD with fieldPath is_partial_form when the checkbox is unchecked', async () => {
    renderPanel(partialFormCompareResult, { plugins: partialFormTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('MyMod.esp')).toBeInTheDocument());
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.click(screen.getByRole('checkbox'));

    // origin deliberately unasserted (objectContaining), same convention as the extended-editor
    // wiring test above: partialFormCompareResult's own MyMod.esp override omits it.
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      fieldPath: 'is_partial_form',
      value: false,
    }));
  });
});

// #620 and this ticket's own triage both missed their mark at this exact layer: every prior
// flags-cell test (FlagCell.test.tsx, DiffRow.test.tsx's "#426" block) hand-feeds
// editableColumns/onEditCell/isBitmask rather than deriving them from a real load() response the
// way editableColumns (RecordPanel.tsx's own four-condition gate) actually is in the running
// extension. This block is the first test in the suite that drives the gesture through that real
// computation — for a scalar cell (the issue's own working comparison case) and a flags cell
// (the reported no-op) side by side on the identical column, so nothing but the field's own type
// differs between the two.
describe('RecordPanel — flags cell editing through real message plumbing (#622)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });

  afterEach(() => vi.unstubAllGlobals());

  // The control: pins the issue's own claim that scalar edits already work in the same
  // session, using the identical tracked/editable column the flags assertions below use — so a
  // regression in either direction (control or flags) is caught by the same fixture.
  it('control: a scalar cell in a tracked, editable column opens an editable input on double click', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('Override Name')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Override Name'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('a flags cell in a tracked, editable column opens its checkbox multi-select on double click', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getAllByText('A, B')).toHaveLength(2));

    fireEvent.doubleClick(screen.getAllByText('A, B')[1]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('F2 on a focused, editable flags cell opens the same multi-select', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getAllByText('A, B')).toHaveLength(2));

    const cell = screen.getAllByText('A, B')[1];
    fireEvent.click(cell); // focuses only — a plain first click must not open (ADR-0034)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    fireEvent.keyDown(cell.closest('td')!, { key: 'F2' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('toggling a flag posts EDIT_FIELD with the toggled bitmask — working-tree dirt', async () => {
    renderPanel(flagsCompareResult, { plugins: flagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getAllByText('A, B')).toHaveLength(2));
    vi.mocked(vscode.postMessage).mockClear();

    fireEvent.doubleClick(screen.getAllByText('A, B')[1]);
    fireEvent.click(screen.getAllByRole('checkbox')[0]); // uncheck A (bit 1): 3 ^ 1 = 2

    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.EDIT_FIELD,
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      fieldPath: 'Flags',
      value: '2',
    }));
  });
});

describe('RecordPanel — conflict color coding', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Each field's own diffs[].conflictAll drives its own row — never the record-wide
  // CompareResult.conflictAll smeared onto every row — exercised
  // end-to-end through RecordPanel's merge/recursion pipeline (not just DiffRow's own props).
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

  // The regression guard: two sibling fields, only one differs — the agreeing
  // sibling's row must show no background even though the record as a whole (and the other
  // field) is Override. A record-wide smear would incorrectly tint both rows the same way.
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

  it('applies red cell background and red text when cellStates is ConflictLoses', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    const cell = screen.getByText('Bob').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(244, 67, 54, 0.18)');
    expect(cell.style.color).toBe('rgba(244, 67, 54, 1)');
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
    // Resolved per fkCompareResult's diff.resolutions — labeled with the "EditorID [FormKey]" composite, so the
    // reference is identifiable from the cell alone rather than only by its EditorID.
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

  // ADR-0039: the string cell's right-click command reaches the extended editor only
  // through this broadcast — no left-click gesture in the webview calls openExtendedFieldEditor.
  // Rival this guards against: code with no listener branch for this message
  // type at all, where nothing would be posted here.
  it('opens the extended editor bridge call when fieldOpenExtendedEditor arrives for the open record', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('TestNPC [000001:Fallout4.esm]'));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
          formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: null, fieldName: 'Name',
          value: 'Override Name', readOnly: false, path: [], rootField: 'Name',
        },
      }));
    });

    // origin deliberately unasserted — compareResult's own fixture overrides omit it (undefined,
    // not the message's `null`), and this test's job is the wiring, not origin's own semantics
    // (columnKey resolves both the same way, ADR-0036).
    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR,
      value: 'Override Name',
      recordLabel: 'TestNPC [000001:Fallout4.esm]',
      fieldName: 'Name',
      plugin: 'MyMod.esp',
      readOnly: false,
    })));
  });

  // readOnly travels through unchanged (the extension host's own OS-permission-based
  // enforcement — extendedFieldEditor.ts's chmod 0o444 — is what actually refuses a save on this
  // path, covered there). This is the webview's own half: the
  // right-click command must still open the tab read-only for an immutable/untracked column.
  it('still opens the extended editor read-only when fieldOpenExtendedEditor arrives with readOnly: true', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('TestNPC [000001:Fallout4.esm]'));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
          formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: null, fieldName: 'Name',
          value: 'Original Name', readOnly: true, path: [], rootField: 'Name',
        },
      }));
    });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR,
      value: 'Original Name',
      readOnly: true,
    })));
  });

  it('ignores fieldOpenExtendedEditor for a different, background record', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('TestNPC [000001:Fallout4.esm]'));
    vi.mocked(vscode.postMessage).mockClear();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: EXTENSION_TO_WEBVIEW.FIELD_OPEN_EXTENDED_EDITOR,
          formKey: '000099:Fallout4.esm', plugin: 'MyMod.esp', origin: null, fieldName: 'Name',
          value: 'Override Name', readOnly: false, path: [], rootField: 'Name',
        },
      }));
    });

    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR }));
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

  it('child row for X shows values from sub-field', async () => {
    renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
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

describe('RecordPanel — no VMAD section on the header record (issue #119)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not show a Scripts (VMAD) section on the header record', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    renderPanel(headerCompareResult, { plugins: headerPluginsResponse });
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Scripts (VMAD)')).not.toBeInTheDocument();
  });
});

describe('RecordPanel — no VMAD section on a VMAD-incapable record type (issue #179)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not show a Scripts (VMAD) section when hasVmad is false, even on a non-header record', async () => {
    vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
    renderPanel(vmadIncapableCompareResult);
    await waitFor(() => screen.getByText('Name'));
    expect(screen.queryByText('Scripts (VMAD)')).not.toBeInTheDocument();
  });

  it('still shows a Scripts (VMAD) section on a non-header record when hasVmad is true', async () => {
    vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
    renderPanel(vmadCapableCompareResult);
    await waitFor(() => expect(screen.getByText('Scripts (VMAD)')).toBeInTheDocument());
  });
});

// vmadTreeAdapter.test.ts's own "the Flags field metadata is readOnly" test already pins this
// at the metadata level (buildVmadRows' output, no rendering involved). This is the
// interaction-level counterpart — real message-fed compare data, expanded through the actual
// ▶ toggles, double-clicked through the actual DiffRow/ScalarCell gesture, on a column that
// (per its own Name field, exercised the same way in the #622 block above) is genuinely
// writable — so nothing but the row's own readOnly veto explains a refusal here.
describe('RecordPanel — VMAD script Flags stay read-only on a tracked, editable column (#622)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('double click on the script Flags row opens nothing, even on an otherwise-editable column', async () => {
    vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
    renderPanel(vmadFlagsCompareResult, { plugins: vmadFlagsTrackedPluginsResponse });
    await waitFor(() => expect(screen.getByText('Scripts (VMAD)')).toBeInTheDocument());

    fireEvent.click(screen.getByText('▶')); // expand the wrapper
    await waitFor(() => expect(screen.getByText('ScriptA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('▶')); // expand the script row
    await waitFor(() => expect(screen.getByText('Local')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Local'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
  });
});

describe('RecordPanel — incomplete-comparison banner (#308 / ADR-0035)', () => {
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

  // A panel already open when the sweep lands must reflect the settled data, not just clear
  // its own banner over stale content — this asserts both halves land together (the refetch, and
  // the banner clearing as a consequence of the fresher conflictsComputed it carries), not just
  // that the message was heard.
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

  // A panel this message reaches before it has ever loaded a record (no formKey) must not throw
  // or attempt a fetch — refresh() itself already no-ops on an empty formKey; this pins that the
  // broadcast handler doesn't bypass that guard.
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
    // Panel should recover from Loading… and show data
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
    await waitFor(() => screen.getByText('Original Name'));

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();
    // the chip itself (and the other column) stay visible
    expect(screen.getByText('Fallout4.esm')).toBeInTheDocument();
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('clicking a collapsed column chip again expands it', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

  it('collapsed column header hides the (read-only) label', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('(read-only)'));
    expect(screen.getByText('(read-only)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
  });

  it('collapsed state survives a LOAD_RECORD navigation to a different formKey', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => screen.getByText('Fallout4.esm'));
    // Still collapsed after navigating to a new record in the same panel load order.
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();
  });
});
