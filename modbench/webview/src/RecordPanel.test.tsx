import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { FieldMetadata } from './types';
import type { LoadResult, RecordSessionClient } from './RecordSessionClient';

// ── shared metadata fixtures ──────────────────────────────────────────────────

const strMeta: FieldMetadata  = { name: 'Name',   type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
const fkMeta: FieldMetadata = {
  name: 'Race', type: 'formKey', isArray: false, validFormKeyTypes: ['race'], enumValues: [],
};

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
      pendingFields: {},
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
      pendingFields: {},
      conflictThis: 'ConflictWins',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerPlugin: 'MyMod.esp',
      winnerValue: 'Override Name',
      cellStates: { 'MyMod.esp': 'ConflictWins' },
    },
  ],
};

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

const threePluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'Mod1.esp', isImmutable: false, loadOrderIndex: 1 },
  { name: 'Mod2.esp', isImmutable: false, loadOrderIndex: 2 },
];

// A minimal stand-in for a fetch Response — the panel reads .ok/.status/.statusText/.json().
function resp(status: number, body: unknown = {}) {
  return { ok: status < 400, status, statusText: `HTTP ${status}`, json: () => Promise.resolve(body) } as unknown as Response;
}

interface FakeOpts {
  changes?: unknown[];
  plugins?: unknown[];
  load?: RecordSessionClient['load'];
  save?: RecordSessionClient['save'];
  createRecord?: RecordSessionClient['createRecord'];
  removeOverride?: RecordSessionClient['removeOverride'];
  saveGroup?: RecordSessionClient['saveGroup'];
  revertGroup?: RecordSessionClient['revertGroup'];
  groupMembers?: RecordSessionClient['groupMembers'];
}

// Issue #122: a fake record-session client. `load` returns the composite view built from the
// given compare fixture; write methods are spies tests can assert on and override.
function fakeClient(compare: unknown, opts: FakeOpts = {}): RecordSessionClient {
  const pl = (opts.plugins ?? pluginsResponse) as { name: string; isImmutable: boolean }[];
  const okLoad = {
    ok: true, result: compare, changes: opts.changes ?? [], plugins: pl,
    immutableSet: new Set(pl.filter(p => p.isImmutable).map(p => p.name)),
  } as unknown as LoadResult;
  return {
    load: opts.load ?? vi.fn().mockResolvedValue(okLoad),
    searchRecords: vi.fn().mockResolvedValue([]),
    save: opts.save ?? vi.fn().mockResolvedValue(resp(200, [])),
    revert: vi.fn().mockResolvedValue(resp(200, [])),
    copyTo: vi.fn().mockResolvedValue(resp(200, [])),
    removeOverride: opts.removeOverride ?? vi.fn().mockResolvedValue(resp(200, {})),
    createRecord: opts.createRecord ?? vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp' })),
    // Issue #139: group save/revert + the member-count read that decides the ↩ confirmation.
    // groupMembers defaults to the staged changes (a group of one), the no-confirmation path.
    saveGroup: opts.saveGroup ?? vi.fn().mockResolvedValue(resp(200, { byPlugin: {}, reindexFailure: null })),
    revertGroup: opts.revertGroup ?? vi.fn().mockResolvedValue(resp(204)),
    groupMembers: opts.groupMembers ?? vi.fn().mockResolvedValue(opts.changes ?? []),
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

  // Issue #111: there is no edit mode. Editing affordances follow the column's plugin
  // mutability, not a mode the user has to enter on every record navigation.
  it('renders no Edit/View mode toggle', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('View')).not.toBeInTheDocument();
  });

  // Issue #136: the panel's Save button called POST /plugins/{plugin}/save — a route the
  // backend does not implement and will not, because ADR-0029 scopes save to a ChangeGroup,
  // never to a plugin. A control that claims to save but 404s is a false affordance
  // (ADR-0026), so it is deleted rather than de-gated. Saving lives in the Pending Changes
  // tree; the Pending column's group-scoped Save/Revert is its own ticket.
  it('offers no per-plugin Save — save is scoped to a ChangeGroup, not a plugin', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  // Issue #111: a cell in an immutable column never activates an input, however it is clicked
  // (spec: field-type rendering rule 6, story 17). Before this, editMode reached the cells with
  // no per-column mutability check, so a read-only column rendered inputs whose PATCH the
  // backend then rejected with a 409 "Plugin is read-only".
  it('a cell in an immutable column renders no input when clicked', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Original Name'));
    expect(screen.queryByDisplayValue('Original Name')).not.toBeInTheDocument();
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

  it('a cell in a mutable column does activate an input when clicked', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));
    expect(screen.getByDisplayValue('Override Name')).toBeInTheDocument();
  });
});

// ── postMessage wiring ────────────────────────────────────────────────────────

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
      pendingFields: {},
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Race',
      values: { 'Fallout4.esm': '00013918:Fallout4.esm' },
      winnerPlugin: 'Fallout4.esm',
      winnerValue: '00013918:Fallout4.esm',
      cellStates: {},
      // ADR-0031: the backend now carries a resolution signal per FormKey value — this fixture
      // mirrors a resolved reference so the Ctrl-hover affordance/navigation tests below exercise
      // real product behavior instead of an unresolved default.
      resolutions: { 'Fallout4.esm': { state: 'ResolvedValidType', recordType: 'race', editorId: 'HumanRace' } },
    },
  ],
};

// Override fixture — conflictAll: 'Override', second plugin has conflictThis: 'Override'
const overrideCompareResult = {
  conflictAll: 'Override',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }],
      pendingFields: {}, conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Override Name' }],
      pendingFields: {}, conflictThis: 'Override' },
  ],
  diffs: [{ fieldName: 'Name', values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
    winnerPlugin: 'MyMod.esp', winnerValue: 'Override Name', cellStates: { 'MyMod.esp': 'Override' } }],
};

// Three-plugin conflict fixture for per-cell ConflictLoses/ConflictWins tests
const threePluginConflictResult = {
  conflictAll: 'Conflict',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Alice' }],
      pendingFields: {}, conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'Mod1.esp', loadOrderIndex: 1, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Bob' }],
      pendingFields: {}, conflictThis: 'ConflictLoses', recordType: 'npc_' },
    { formKey: '000001:Fallout4.esm', plugin: 'Mod2.esp', loadOrderIndex: 2, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Charlie' }],
      pendingFields: {}, conflictThis: 'ConflictWins' },
  ],
  diffs: [{
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'Alice', 'Mod1.esp': 'Bob', 'Mod2.esp': 'Charlie' },
    winnerPlugin: 'Mod2.esp',
    winnerValue: 'Charlie',
    cellStates: { 'Mod1.esp': 'ConflictLoses', 'Mod2.esp': 'ConflictWins' },
  }],
};

describe('RecordPanel — OnlyOne record display', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders field rows for a single-override (OnlyOne) record', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(fkCompareResult, { plugins: [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }] });
    await waitFor(() => expect(screen.getByText('Race')).toBeInTheDocument());
  });
});

// Issue #175: the compare grid's own horizontal scrollbar used to sit at the bottom of the
// (possibly very tall) table, off-screen unless the whole document was scrolled all the way
// down. jsdom has no layout engine, so this can't assert real scrollbar visibility — instead it
// asserts the CSS mechanism a real browser uses to pin the grid's scroll area (and therefore its
// scrollbars) to the viewport regardless of vertical scroll position: a position:fixed panel
// laid out as a flex column, with the grid wrapper as a flex:1/minHeight:0 child that owns its
// own overflow instead of growing with the table's content.
describe('RecordPanel — grid scroll container stays viewport-bound (#175)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pins the panel to the viewport with a flex-column layout', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const { container } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.top).toBe('0px');
    expect(panel.style.right).toBe('0px');
    expect(panel.style.bottom).toBe('0px');
    expect(panel.style.left).toBe('0px');
    expect(panel.style.display).toBe('flex');
    expect(panel.style.flexDirection).toBe('column');
  });

  it('gives the grid wrapper its own bounded overflow instead of growing with the table', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    const wrapper = screen.getByRole('table').parentElement as HTMLElement;
    expect(wrapper.style.overflow).toBe('auto');
    expect(wrapper.style.flex).toBe('1 1 auto');
    expect(wrapper.style.minHeight).toBe('0');
  });
});

describe('RecordPanel — conflict color coding', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies green row background when conflictAll is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(overrideCompareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr')!;
    expect(row.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });

  it('applies orange row background when conflictAll is Conflict', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr')!;
    expect(row.style.backgroundColor).toBe('rgba(255, 152, 0, 0.20)');
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
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  const fkPlugins = [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }];

  it('calls vscode.postMessage with type openRecord when a FormKey link is Ctrl+clicked', async () => {
    renderPanel(fkCompareResult, { plugins: fkPlugins });
    // Resolved per fkCompareResult's diff.resolutions — labeled with the EditorID, not the raw FormKey.
    await waitFor(() => screen.getByText('HumanRace'));
    fireEvent.click(screen.getByText('HumanRace'), { ctrlKey: true });
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

// ── LOAD_RECORD state management (bugs 1, 2, 3) ───────────────────────────────

// ── Struct sub-row display ────────────────────────────────────────────────────

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
      pendingFields: {},
      conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp',
      loadOrderIndex: 1,
      isWinner: true,
      editorId: 'TestNPC',
      fields: [{ metadata: structFieldMeta, value: { X: 15, Y: 20 } }],
      pendingFields: {},
      conflictThis: 'Override',
    },
  ],
  diffs: [
    {
      fieldName: 'Bounds',
      values: { 'Fallout4.esm': { X: 10, Y: 20 }, 'MyMod.esp': { X: 15, Y: 20 } },
      winnerPlugin: 'MyMod.esp',
      winnerValue: { X: 15, Y: 20 },
      cellStates: { 'MyMod.esp': 'Override' },
      children: [
        {
          fieldName: 'X',
          values: { 'Fallout4.esm': 10, 'MyMod.esp': 15 },
          winnerPlugin: 'MyMod.esp',
          winnerValue: 15,
          cellStates: { 'MyMod.esp': 'Override' },
        },
        {
          fieldName: 'Y',
          values: { 'Fallout4.esm': 20, 'MyMod.esp': 20 },
          winnerPlugin: 'MyMod.esp',
          winnerValue: 20,
          cellStates: { 'MyMod.esp': 'IdenticalToMaster' },
        },
      ],
    },
  ],
};

describe('RecordPanel — struct sub-rows', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

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

  it('child edit calls save with parent field name and merged struct', async () => {
    const { client } = renderPanel(structCompareResult);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));

    // The X sub-field in the MyMod.esp column (value 15) — Fallout4.esm is immutable, so its
    // cells never activate. Click the cell to activate its input, then edit it.
    fireEvent.click(screen.getByText('15'));
    const inputFor15 = screen.getByDisplayValue('15');
    fireEvent.change(inputFor15, { target: { value: '99' } });
    fireEvent.blur(inputFor15);

    // Y is preserved from MyMod.esp's disk value — the whole struct restages, not just X.
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        { Bounds: { X: 99, Y: 20 } },
        undefined,
      ),
    );
  });
});

// ── 422 ProblemDetails surfacing (issue #85: ESL-ineligible / read-only) ─────

describe('RecordPanel — 422 ProblemDetails detail is surfaced', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the ProblemDetails detail text when a stage is rejected with 422', async () => {
    // ProblemDetails object (not the reference-error array) — e.g. the ESL rejection reason.
    const save = vi.fn().mockResolvedValue(resp(422, {
      detail: "'MyMod.esp' can't be an ESL: 1 FormID(s) fall outside the ESL range (0x001–0xFFF): 001000:MyMod.esp",
    }));
    renderPanel(compareResult, { save });
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));

    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(screen.getByText(/can't be an ESL/)).toBeInTheDocument(),
    );
  });
});

// ── Issue #86: Add Master picker (header record) ─────────────────────────────

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
      pendingFields: {},
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'masters',
      values: { 'MyMod.esp': ['Fallout4.esm'] },
      winnerPlugin: 'MyMod.esp',
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

describe('RecordPanel — Add Master picker (issue #86)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const headerOpts = { plugins: headerPluginsResponse };

  it('F1: shows "Add Master…" on the header record, with no mode to enter first', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    renderPanel(headerCompareResult, headerOpts);
    await waitFor(() => expect(screen.getByText('Add Master…')).toBeInTheDocument());
  });

  it('F1: does not show "Add Master…" on a non-header record', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Name'));
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
  });

  it("F2: picker offers loaded plugins minus already-mastered ones and the record's own plugin", async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    renderPanel(headerCompareResult, headerOpts);
    await waitFor(() => screen.getByText('Add Master…'));
    fireEvent.click(screen.getByText('Add Master…'));

    // Fallout4.esm is already a master → excluded. DLCRobot.esm is loaded, not yet a master →
    // offered. MyMod.esp (the record's own plugin) never appears as a candidate.
    expect(screen.getByText('DLCRobot.esm')).toBeInTheDocument();
    expect(screen.queryByText('Fallout4.esm')).not.toBeInTheDocument();
  });

  it('F3: selecting a plugin stages the full appended masters array via save', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const { client } = renderPanel(headerCompareResult, headerOpts);
    await waitFor(() => screen.getByText('Add Master…'));
    fireEvent.click(screen.getByText('Add Master…'));
    fireEvent.mouseDown(screen.getByText('DLCRobot.esm'));

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000000:MyMod.esp',
        'MyMod.esp',
        { masters: ['Fallout4.esm', 'DLCRobot.esm'] },
        undefined,
      ),
    );
  });

  it('F3: a not_append_only 422 rejection surfaces a readable message', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const save = vi.fn().mockResolvedValue(resp(422, { fieldErrors: [{ fieldPath: 'masters', reason: 'not_append_only' }] }));
    renderPanel(headerCompareResult, { ...headerOpts, save });
    await waitFor(() => screen.getByText('Add Master…'));
    fireEvent.click(screen.getByText('Add Master…'));
    fireEvent.mouseDown(screen.getByText('DLCRobot.esm'));

    await waitFor(() =>
      expect(screen.getByText(/masters can only be appended to/)).toBeInTheDocument(),
    );
  });

});

describe('RecordPanel — no VMAD section on the header record (issue #119)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not show a Scripts (VMAD) section on the header record', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    renderPanel(headerCompareResult, { plugins: headerPluginsResponse });
    await waitFor(() => screen.getByText('Add Master…'));
    expect(screen.queryByText('Scripts (VMAD)')).not.toBeInTheDocument();
  });
});

// Issue #179: CMPO ("Component") records categorically cannot carry a VMAD (script attachment)
// subrecord — the backend now reflects this per record type (RecordTableSchema.HasVmad, sourced
// from Mutagen's IHaveVirtualMachineAdapterGetter) and threads it onto CompareResult.hasVmad.
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
      pendingFields: {},
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'MyMod.esp': 'Some Component' },
      winnerPlugin: 'MyMod.esp',
      winnerValue: 'Some Component',
      cellStates: {},
    },
  ],
};

// A VMAD-capable record type (e.g. an NPC) with no scripts attached yet — hasVmad: true but no
// `vmad` data. VmadSection should still render its (empty, addable) section: hasVmad gates whether
// the section can ever appear for this type, not whether this particular record has scripts.
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
      pendingFields: {},
      conflictThis: 'OnlyOne',
    },
  ],
  diffs: [
    {
      fieldName: 'Name',
      values: { 'MyMod.esp': 'Test Name' },
      winnerPlugin: 'MyMod.esp',
      winnerValue: 'Test Name',
      cellStates: {},
    },
  ],
};

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

// ── Top-level pending no-op suppression ──────────────────────────────────────

describe('RecordPanel — top-level pending suppressed when identical to disk', () => {
  // Pending value for Name is 'Override Name' — identical to the disk value.
  // DiffRow should treat this as no change and NOT yellow-highlight the pending cell.
  const noOpPendingResult = {
    conflictAll: 'Override',
    overrides: [
      {
        formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
        loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Original Name' }],
        pendingFields: {}, conflictThis: 'Master',
      },
      {
        formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
        loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
        fields: [{ metadata: strMeta, value: 'Override Name' }],
        pendingFields: { Name: 'Override Name' },
        conflictThis: 'Override',
      },
    ],
    diffs: [{
      fieldName: 'Name',
      values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Override Name' },
      winnerPlugin: 'MyMod.esp', winnerValue: 'Override Name',
      cellStates: { 'MyMod.esp': 'Override' },
    }],
  };

  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not yellow-highlight the pending cell when pending value equals disk value', async () => {
    renderPanel(noOpPendingResult);
    await waitFor(() => screen.getByText('Name'));

    const nameRow = screen.getByText('Name').closest('tr')!;
    const yellowCells = Array.from(nameRow.querySelectorAll('td')).filter(
      td => td.style.backgroundColor === 'rgba(255, 200, 50, 0.10)',
    );
    expect(yellowCells.length).toBe(0);
  });
});

describe('RecordPanel — LOAD_RECORD state management', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  // Issue #136: the "resets savingPlugin when LOAD_RECORD arrives while a save is in-flight"
  // test lived here. It exercised the per-plugin Save button, which called a route the backend
  // never implemented — it asserted a dead path, so it goes with the button.

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
      .mockResolvedValue({ ok: true, result: compareResult, changes: [], plugins: pluginsResponse, immutableSet: new Set(['Fallout4.esm']) });
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

// ── Column collapse (issue #3) ────────────────────────────────────────────────

describe('RecordPanel — column collapse (issue #3)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

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
    // Still collapsed after navigating to a new record in the same panel session.
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();
  });
});

// ── Drag affordance (issue #3) ────────────────────────────────────────────────

describe('RecordPanel — drag affordance on field cells', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  // Issue #111: drag-to-copy is always on — there is no mode to enter. A read-only source
  // column is draggable too: dragging is a copy, so only the drop target's mutability matters.
  it('a field cell in a read-only column is draggable with a grab cursor, with no mode to enter', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));
    const cell = screen.getByText('Original Name').closest('td')!;
    expect(cell.getAttribute('draggable')).toBe('true');
    expect(cell.style.cursor).toBe('grab');
  });

  it('a field cell in an editable column is draggable with a grab cursor, with no mode to enter', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    expect(cell.getAttribute('draggable')).toBe('true');
    expect(cell.style.cursor).toBe('grab');
  });

  // Issue #111: a draggable ancestor swallows text selection inside an input — the browser
  // starts a drag instead of selecting. So a cell stops being draggable exactly while its own
  // input is active, and becomes draggable again when the input closes.
  it('a cell is not draggable while its own input is active', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    fireEvent.click(screen.getByText('Override Name'));

    expect(screen.getByDisplayValue('Override Name')).toBeInTheDocument();
    expect(cell.getAttribute('draggable')).toBe('false');
  });

  it('a cell becomes draggable again once its input is dismissed', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    fireEvent.click(screen.getByText('Override Name'));
    fireEvent.blur(screen.getByDisplayValue('Override Name'));

    expect(cell.getAttribute('draggable')).toBe('true');
  });

  // Other cells keep their drag affordance while one cell is being edited.
  it('a sibling cell stays draggable while another cell is being edited', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const sibling = screen.getByText('Original Name').closest('td')!;
    fireEvent.click(screen.getByText('Override Name'));

    expect(sibling.getAttribute('draggable')).toBe('true');
  });
});

// ── Drag-drop staging (issue #3) ──────────────────────────────────────────────

describe('RecordPanel — drag-drop stages a pending field change', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('dragging from a read-only source column and dropping on an editable target column stages the value there (copy, not move)', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));

    // Fallout4.esm is immutable — dragging FROM it is allowed (copy source).
    const sourceCell = screen.getByText('Original Name').closest('td')!;
    // MyMod.esp is mutable — a valid drop target.
    const targetCell = screen.getByText('Override Name').closest('td')!;

    fireEvent.dragStart(sourceCell);
    fireEvent.drop(targetCell);

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        { Name: 'Original Name' },
        undefined,
      ),
    );
  });

  it('dropping on a read-only (immutable) target column is rejected as a no-op — no save is sent', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    // MyMod.esp is mutable — a valid drag source.
    const sourceCell = screen.getByText('Override Name').closest('td')!;
    // Fallout4.esm is immutable — must reject the drop.
    const targetCell = screen.getByText('Original Name').closest('td')!;

    fireEvent.dragStart(sourceCell);
    fireEvent.drop(targetCell);

    // Let any (incorrect) async staging work run before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.save).not.toHaveBeenCalled();
  });

  // Issue #204 / ADR-0033: a compound (struct/array) field's collapsed summary row is a drag
  // source for its whole value too — not just scalar leaves. Reuses structCompareResult (the
  // struct sub-rows fixture below) rather than a new fixture.
  it('dragging a collapsed struct summary onto another column stages the whole struct value, and logs it the same as a scalar drag', async () => {
    vi.mocked(vscode.postMessage).mockClear();
    const { client } = renderPanel(structCompareResult);
    await waitFor(() => expect(screen.getAllByText('{…}').length).toBeGreaterThan(0));

    // Fallout4.esm (immutable, first column) is the drag source; MyMod.esp (mutable, second
    // column) is the drop target — only the target's mutability gates the drop.
    const cells = screen.getAllByText('{…}');
    const sourceCell = cells[0].closest('td')!;
    const targetCell = cells[1].closest('td')!;

    fireEvent.dragStart(sourceCell);
    fireEvent.drop(targetCell);

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'MyMod.esp',
        { Bounds: { X: 10, Y: 20 } },
        undefined,
      ),
    );

    // Issue #200's policy: a successful drag-copy logs DEBUG the same as any other staged edit
    // (handleEdit is the single shared call site) — pinned explicitly here so a later refactor
    // of the hasChildren branch can't silently drop it, the same way #200 pinned it for VMAD
    // and Condition leaf edits sharing that same call site.
    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]: [{ message?: string }]) => m).filter((m: { message?: string }) => m.message);
    expect(message).toContain('Bounds');
    expect(message).toContain('000001:Fallout4.esm');
  });
});

// ── Column header context menu (issue #3) ─────────────────────────────────────

describe('RecordPanel — column header context menu', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('right-clicking a plugin column header shows Copy All to Pending, Copy as New Record, Copy as Override…, and Remove', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as New Record' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as Override…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument();
  });

  it('Remove is disabled on an immutable plugin column, enabled on a mutable one', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Fallout4.esm'));

    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveAttribute('aria-disabled', 'true');

    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Remove' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  // Issue #176: unlike Remove, Copy as Override… never touches the right-clicked
  // column's own plugin — handleCopyTo only reads the currently-loaded record and writes to
  // whatever target the user picks next — so it stays enabled even from an immutable column,
  // the same way Copy All to Pending / Copy as New Record already do.
  it('Copy as Override… is enabled even when right-clicking an immutable column', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Fallout4.esm'));
    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy as Override…' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('pressing Escape closes the menu', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Copy All to Pending' })).not.toBeInTheDocument();
  });

  it('clicking outside the menu closes it', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();

    fireEvent.click(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Copy All to Pending' })).not.toBeInTheDocument();
  });
});

// ── Remove (issue #3, renamed from "Remove Override" in #177) ─────────────────

describe('RecordPanel — Remove', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clicking Remove on a mutable column stages a delete via removeOverride', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

    await waitFor(() =>
      expect(client.removeOverride).toHaveBeenCalledWith('000001:Fallout4.esm', 'MyMod.esp'),
    );
  });

  it('Remove is disabled and inert on an immutable column — no delete call is made', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Fallout4.esm'));
    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.removeOverride).not.toHaveBeenCalled();
  });
});

// ── Copy All to Pending (issue #3) ────────────────────────────────────────────

describe('RecordPanel — Copy All to Pending', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens a target picker offering mutable plugins other than the source column', async () => {
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));

    expect(screen.getByRole('menuitem', { name: 'Mod2.esp' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mod1.esp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Fallout4.esm' })).not.toBeInTheDocument();
  });

  it('selecting a target stages one save with every field from the source column', async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'Mod2.esp',
        { Name: 'Bob' },
        undefined,
      ),
    );
  });
});

// ── Copy as New Record (issue #3) ─────────────────────────────────────────────

describe('RecordPanel — Copy as New Record', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the same target picker as Copy All to Pending', async () => {
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as New Record' }));

    expect(screen.getByRole('menuitem', { name: 'Mod2.esp' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mod1.esp' })).not.toBeInTheDocument();
  });

  it('selecting a target creates a new record of the source column\'s type, then stages every source field on it', async () => {
    const createRecord = vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp', groupId: 'g1' }));
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse, createRecord });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as New Record' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    // Creates a blank record of the source column's type in the target plugin…
    await waitFor(() => expect(client.createRecord).toHaveBeenCalledWith('Mod2.esp', 'npc_'));

    // …then stages every source field onto the newly-created FormKey.
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith('000099:Mod2.esp', 'Mod2.esp', { Name: 'Bob' }),
    );
  });
});

// ── Copy as Override… (issue #176) ─────────────────────────────────────────────
//
// Formerly a standalone button in each mutable PluginHeader column; now the same handleCopyTo
// flow, triggered from the right-click menu and reusing the shared PluginTargetPicker unmodified
// — same self-exclusion as Copy All to Pending / Copy as New Record (issue #176 design: "one
// shared component, one behavior"). Unlike those two, handleCopyTo(target) never reads the
// right-clicked column's plugin — it always copies the currently-loaded record (formKey) —
// so there is no per-source-column field payload to assert here, only the target and formKey.

describe('RecordPanel — Copy as Override…', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens a target picker offering mutable plugins other than the source column', async () => {
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Override…' }));

    expect(screen.getByRole('menuitem', { name: 'Mod2.esp' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mod1.esp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Fallout4.esm' })).not.toBeInTheDocument();
  });

  it('selecting a target copies the current record to it via copyTo', async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Override…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(client.copyTo).toHaveBeenCalledWith('000001:Fallout4.esm', 'Mod2.esp'),
    );
  });
});

// ── Pending cells route through the type-aware renderer (issue #137) ───────────

// The Pending column exists so a staged edit can be compared against every plugin's disk value.
// The disk columns render through renderCell (enums/flags → names, FormKeys → links); the pending
// cell must speak the same language, or a user comparing a pending "3" against a disk "Fire" cannot
// tell whether anything changed. These assert what the pending cell renders, not how.

const pendingFlagsMeta: FieldMetadata = {
  name: 'Flags', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumValues: ['Fire', 'Ice', 'Shock'], enumBitValues: ['1', '2', '4'], isBitmask: true,
};

// One record with a bitmask field: disk "1" (Fire), staged "3" (Fire + Ice). Disk cell shows
// "Fire", pending shows "Fire, Ice" — so "Fire, Ice" uniquely identifies the pending cell.
const pendingFlagsResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: pendingFlagsMeta, value: '1' }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: pendingFlagsMeta, value: '1' }],
      pendingFields: { Flags: '3' }, conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Flags',
    values: { 'Fallout4.esm': '1', 'MyMod.esp': '1' },
    winnerPlugin: 'MyMod.esp', winnerValue: '1',
    cellStates: { 'MyMod.esp': 'Override' },
  }],
};

// A FormKey field: disk "000019:Fallout4.esm", staged "0001F4:Fallout4.esm".
const pendingFormKeyResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: fkMeta, value: '000019:Fallout4.esm' }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: fkMeta, value: '000019:Fallout4.esm' }],
      pendingFields: { Race: '0001F4:Fallout4.esm' }, conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Race',
    values: { 'Fallout4.esm': '000019:Fallout4.esm', 'MyMod.esp': '000019:Fallout4.esm' },
    winnerPlugin: 'MyMod.esp', winnerValue: '000019:Fallout4.esm',
    cellStates: { 'MyMod.esp': 'Override' },
  }],
};

// Same FormKey field, but the staged value clears the reference to null.
const pendingNullResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: fkMeta, value: '000019:Fallout4.esm' }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: fkMeta, value: '000019:Fallout4.esm' }],
      pendingFields: { Race: null }, conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Race',
    values: { 'Fallout4.esm': '000019:Fallout4.esm', 'MyMod.esp': '000019:Fallout4.esm' },
    winnerPlugin: 'MyMod.esp', winnerValue: '000019:Fallout4.esm',
    cellStates: { 'MyMod.esp': 'Override' },
  }],
};

describe('RecordPanel — pending cells render type-aware (issue #137)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders a pending flags value as its active flag names, not a raw integer', async () => {
    renderPanel(pendingFlagsResult);
    await waitFor(() => screen.getByText('Flags'));

    // The staged value "3" must resolve to "Fire, Ice"; the raw decimal must not appear.
    expect(screen.getByText('Fire, Ice')).toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('renders a pending FormKey as a followable link, not a plain string', async () => {
    renderPanel(pendingFormKeyResult, {
      changes: [{
        id: 'chg-fk', plugin: 'MyMod.esp', fieldPath: 'Race', recordType: 'npc_', formKey: '000001:Fallout4.esm',
        resolutions: { '': { state: 'ResolvedValidType', recordType: 'race', editorId: 'SomeRace' } },
      }],
    });
    await waitFor(() => screen.getByText('Race'));

    // The staged FormKey resolves, so it renders as its EditorID and is a link (a button), so
    // Ctrl+click follows the reference — a plain <span> could not.
    const link = screen.getByText('SomeRace');
    expect(link.tagName).toBe('BUTTON');
    fireEvent.click(link, { ctrlKey: true });
    expect(vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_RECORD, formKey: '0001F4:Fallout4.esm' }),
    );
  });

  it('renders a pending null value as an empty "—" cell, never "null"/"undefined"', async () => {
    renderPanel(pendingNullResult);
    await waitFor(() => screen.getByText('Race'));

    // Staging a clear leaves a null pending value; it must read as the same em-dash the disk
    // columns use for absence (rule 5), not the literal text "null"/"undefined".
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });

  // Issue #203 (reverses #137's read-only guard): routing the pending value through renderCell
  // with editable=true means every field type's own editor is now reachable from the pending
  // cell too, flags included — clicking "Fire, Ice" opens the same multi-select checkboxes a
  // disk cell's flag field would.
  it('clicking a pending flags value opens its multi-select editor, the same as a disk cell', async () => {
    renderPanel(pendingFlagsResult);
    await waitFor(() => screen.getByText('Flags'));

    fireEvent.click(screen.getByText('Fire, Ice'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(3); // Fire, Ice, Shock
  });
});

// ── Pending column save / revert (issue #139) ──────────────────────────────────
//
// The Pending column's actions, every one scoped to a ChangeGroup (ADR-0029). A staged edit
// to Name on the mutable column, with a matching pending change so the ↩ and the group actions
// key on its id.

const pendingNameResult = {
  conflictAll: 'Override',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm',
      loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'Original Name' }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'Original Name' }],
      pendingFields: { Name: 'Staged Name' }, conflictThis: 'Override',
    },
  ],
  diffs: [{
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'Original Name', 'MyMod.esp': 'Original Name' },
    winnerPlugin: 'MyMod.esp', winnerValue: 'Original Name',
    cellStates: { 'MyMod.esp': 'Override' },
  }],
};

const soloChange = [{ id: 'chg-1', plugin: 'MyMod.esp', fieldPath: 'Name', recordType: 'npc_', formKey: '000001:Fallout4.esm' }];

// A two-member component: the staged Name edit dragged a WEAP field edit with it (ADR-0028).
const twoMemberGroup = [
  { id: 'chg-1', plugin: 'MyMod.esp', fieldPath: 'Name', recordType: 'npc_', formKey: '000001:Fallout4.esm' },
  { id: 'chg-2', plugin: 'OtherMod.esp', fieldPath: 'BoundWeapon', recordType: 'weap', formKey: '001234:MyMod.esp' },
];

const okSave = (byPlugin: unknown, reindexFailure: unknown = null) => resp(200, { byPlugin, reindexFailure });

describe('RecordPanel — Pending column save/revert (issue #139)', () => {
  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  it('right-clicking a pending value offers Save Group and Revert Group', async () => {
    renderPanel(pendingNameResult, { changes: soloChange });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    expect(screen.getByRole('menuitem', { name: 'Save Group' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Revert Group' })).toBeInTheDocument();
  });

  it('Save Group saves that change\'s component and refreshes the grid', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave({}));
    const { client } = renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));

    await waitFor(() => expect(saveGroup).toHaveBeenCalledWith('chg-1'));
    // The grid is reloaded to reflect what reached disk (load fires again after the save).
    await waitFor(() => expect((client.load as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it('names which plugins saved and which could not on a partial save', async () => {
    // Applied nothing, one field read-only → that plugin wholly failed (ADR-0026).
    const saveGroup = vi.fn().mockResolvedValue(okSave({
      'MyMod.esp': { backupPath: 'b', applied: [], readOnly: ['Name'], notFound: [], createFailed: [] },
    }));
    renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));

    await waitFor(() => expect(screen.getByText(/could not write MyMod\.esp/)).toBeInTheDocument());
    expect(screen.getByText(/remain queued/)).toBeInTheDocument();
  });

  it('warns to reload after a save whose reindex went stale, without reading as a failure', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave(
      { 'MyMod.esp': { backupPath: 'b', applied: ['Name'], readOnly: [], notFound: [], createFailed: [] } },
      { plugins: ['MyMod.esp'], reason: 'boom' },
    ));
    renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));

    await waitFor(() => expect(screen.getByText(/index is now stale/)).toBeInTheDocument());
    // A completed-but-stale save is a warning, not a failure — it must not claim the save failed.
    expect(screen.queryByText(/Partial save/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not write/)).not.toBeInTheDocument();
  });

  it('the inline ↩ on a group of one reverts immediately with no confirmation', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('↩'));

    await waitFor(() => expect(revertGroup).toHaveBeenCalledWith('chg-1'));
    // No confirmation modal for a group of one.
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
  });

  it('the inline ↩ on a multi-member group confirms, listing the members, before reverting', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('↩'));

    // The confirmation lists the linked member that travels with the group.
    await waitFor(() => expect(screen.getByText(/BoundWeapon/)).toBeInTheDocument());
    // Nothing is reverted until the user confirms.
    expect(revertGroup).not.toHaveBeenCalled();
  });

  it('reverting the whole group on confirm calls revertGroup, not the single-change endpoint', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    const { client } = renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('↩'));
    await waitFor(() => screen.getByRole('button', { name: 'Revert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));

    await waitFor(() => expect(revertGroup).toHaveBeenCalledWith('chg-1'));
    expect(client.revert).not.toHaveBeenCalled();
  });

  it('cancelling the confirmation reverts nothing', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('↩'));
    await waitFor(() => screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revertGroup).not.toHaveBeenCalled();
  });

  it('Revert Group from the context menu confirms for a multi-member group', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert Group' }));

    await waitFor(() => expect(screen.getByText(/BoundWeapon/)).toBeInTheDocument());
    expect(revertGroup).not.toHaveBeenCalled();
  });

  it('Revert Group from the context menu on a group of one reverts with no confirmation', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert Group' }));

    await waitFor(() => expect(revertGroup).toHaveBeenCalledWith('chg-1'));
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
  });
});

// Fixtures shared by the two describe blocks below (right-click reveal, and direct editing).

const pendingFkResult = {
  conflictAll: 'Override',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: fkMeta, value: '00013918:Fallout4.esm' }],
      pendingFields: {}, conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: fkMeta, value: '00013918:Fallout4.esm' }],
      pendingFields: { Race: '00099999:MyMod.esp' }, conflictThis: 'Override' },
  ],
  diffs: [{
    fieldName: 'Race',
    values: { 'Fallout4.esm': '00013918:Fallout4.esm', 'MyMod.esp': '00013918:Fallout4.esm' },
    winnerPlugin: 'MyMod.esp', winnerValue: '00013918:Fallout4.esm',
    cellStates: { 'MyMod.esp': 'Override' },
  }],
};

const soloChangeFk = [{
  id: 'chg-1', plugin: 'MyMod.esp', fieldPath: 'Race', recordType: 'npc_', formKey: '000001:Fallout4.esm',
  resolutions: { '': { state: 'ResolvedValidType', recordType: 'race', editorId: 'SomeRace' } },
}];

describe('RecordPanel — Pending column right-click reveal (issue #203, moved from plain-click)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Ctrl+click on a pending FormKey value still posts openRecord, not a reveal', async () => {
    renderPanel(pendingFkResult, { changes: soloChangeFk });
    await waitFor(() => screen.getByText('SomeRace'));

    fireEvent.click(screen.getByText('SomeRace'), { ctrlKey: true });

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.OPEN_RECORD,
      formKey: '00099999:MyMod.esp',
    });
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE,
    }));
  });

  it('clicking the inline ↩ reverts the group and does not also post a reveal', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('↩'));

    await waitFor(() => expect(revertGroup).toHaveBeenCalledWith('chg-1'));
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE,
    }));
  });

  it('right-click offers Reveal in Pending Changes Tree alongside Save Group / Revert Group', async () => {
    renderPanel(pendingNameResult, { changes: soloChange });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));

    expect(screen.getByRole('menuitem', { name: 'Reveal in Pending Changes Tree' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save Group' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Revert Group' })).toBeInTheDocument();
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE,
    }));
  });

  // Issue #203: reveal moves from plain-click to the pending cell's right-click menu.
  it('right-clicking a pending value then choosing Reveal posts revealPendingChange with the change id', async () => {
    renderPanel(pendingNameResult, { changes: soloChange });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Pending Changes Tree' }));

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE,
      changeId: 'chg-1',
    });
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Pending Changes Tree' })).not.toBeInTheDocument();
  });
});

// ── Pending column direct editing (issue #203, reverses #140) ───────────────────
//
// A pending value's cell is now directly editable, on the same terms as a disk cell — plain
// click no longer reveals the change in the Pending Changes tree; that gesture moved to the
// right-click menu tested above.

describe('RecordPanel — Pending column direct editing (issue #203)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('plain click on a pending value opens an editable input, on the same terms as a disk cell', async () => {
    renderPanel(pendingNameResult, { changes: soloChange });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('Staged Name'));

    expect(screen.getByDisplayValue('Staged Name')).toBeInTheDocument();
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.REVEAL_PENDING_CHANGE,
    }));
  });

  // Issue #200/#203: a pending-cell edit reaches the SAME handleEdit→stageChange path a disk-cell
  // edit does — no new/separate logging code — so it logs DEBUG identically (pinned explicitly,
  // matching how #200 already pinned this for the drag-copy path sharing the same call site).
  it('committing an edit on a pending value stages it and logs DEBUG the same as a disk-cell edit', async () => {
    const save = vi.fn().mockResolvedValue(resp(200, []));
    renderPanel(pendingNameResult, { changes: soloChange, save });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('Staged Name'));
    const input = screen.getByDisplayValue('Staged Name');
    fireEvent.change(input, { target: { value: 'Re-edited Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { Name: 'Re-edited Name' }, undefined,
    ));
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    });
  });
});

// ── Pending Changes tree notification (issue #174) ──────────────────────────────
//
// The record editor webview and the extension host's Pending Changes tree are different
// processes, bridged only by postMessage. Every mutating handler here refreshes its own
// webview state via `refresh(formKey)` on success, but that alone never reaches the tree —
// each one must also post PENDING_CHANGED so extension.ts can call
// changeGroupTreeProvider.refresh(). A failed mutation must not post it (nothing pending
// actually changed).

describe('RecordPanel — pending tree notification (issue #174)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an ordinary field edit posts pendingChanged once staged', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));
    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('a rejected field edit does not post pendingChanged', async () => {
    const save = vi.fn().mockResolvedValue(resp(409, {}));
    renderPanel(compareResult, { save });
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));
    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED });
  });

  it('selecting a Copy as Override… target posts pendingChanged once staged', async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Override…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() => expect(client.copyTo).toHaveBeenCalledWith('000001:Fallout4.esm', 'Mod2.esp'));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED });
  });

  it('Remove posts pendingChanged once staged', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('Copy All to Pending posts pendingChanged once staged', async () => {
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('Copy as New Record posts pendingChanged once staged', async () => {
    const createRecord = vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp' }));
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse, createRecord });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as New Record' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('Save Group posts pendingChanged once the save completes', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave({}));
    renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));
    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('the inline ↩ revert posts pendingChanged once the revert completes', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));
    fireEvent.click(screen.getByText('↩'));

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });
});

// ── Action logging (issue #200) ─────────────────────────────────────────────────
//
// The webview has no route to the 'Modbench' output channel (#198) of its own — it's a
// separate process from the extension host, bridged only by postMessage. Every already-shipped
// interaction below must post a LOG message describing what happened, per #198's DEBUG/INFO/WARN
// policy.

const vmadEditableCompareResult = {
  conflictAll: 'OnlyOne',
  hasVmad: true,
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Test Name' }],
      pendingFields: {}, conflictThis: 'OnlyOne',
    },
  ],
  diffs: [{
    fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
    winnerPlugin: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {},
  }],
  vmad: {
    scripts: [{
      name: 'MyScript', flags: { 'MyMod.esp': 'Local' }, winnerPlugin: 'MyMod.esp', cellStates: {},
      properties: [{
        name: 'Enabled', kind: 'scalar', values: { 'MyMod.esp': false }, types: { 'MyMod.esp': 'Bool' },
        winnerPlugin: 'MyMod.esp', cellStates: {}, children: null,
      }],
    }],
  },
};

const conditionEditableCompareResult = {
  conflictAll: 'OnlyOne',
  hasVmad: false,
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Test Name' }],
      pendingFields: {}, conflictThis: 'OnlyOne',
    },
  ],
  diffs: [{
    fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' },
    winnerPlugin: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {},
  }],
  conditions: {
    groups: [{
      fieldPath: 'Conditions',
      conditions: [{
        index: 0,
        perPlugin: {
          'MyMod.esp': {
            function: 'GetStageDone', operator: 'EqualTo', or: false, runOnTarget: 'Subject',
            runOnReference: null, useGlobal: false, comparisonFloat: 3, comparisonGlobal: null, parameters: [],
          },
        },
        winnerPlugin: 'MyMod.esp', cellStates: {}, fieldCellStates: {},
      }],
    }],
  },
};

const mutablePlugin = [{ name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 0 }];

describe('RecordPanel — action logging (issue #200)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a disk-cell field edit logs a DEBUG line naming the plugin, field, and record', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));
    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]: [{ message?: string }]) => m).filter((m: { message?: string }) => m.message);
    expect(message).toContain('Name');
    expect(message).toContain('000001:Fallout4.esm');
  });

  it('a rejected field edit does not log', async () => {
    const save = vi.fn().mockResolvedValue(resp(409, {}));
    renderPanel(compareResult, { save });
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));
    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.LOG }));
  });

  // Issue #200: VMAD leaf edits funnel through the identical handleEdit→stageChange path as a
  // disk-cell edit above, with no source-specific branching — tested explicitly anyway (a shared
  // surface with multiple renderers is exactly where "wired the obvious one, missed the others"
  // hides).
  it('a VMAD leaf edit logs a DEBUG line naming the plugin, VMAD path, and record', async () => {
    renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('false'));
    fireEvent.click(screen.getByText('false'));
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]: [{ message?: string }]) => m).filter((m: { message?: string }) => m.message);
    expect(message).toContain(String.raw`VMAD\MyScript\Enabled`);
    expect(message).toContain('000001:Fallout4.esm');
  });

  // Issue #203: a pending-cell edit (VMAD included) reaches the SAME handleEdit→stageChange path
  // as the disk-cell edit above — no new/separate logging code — pinned explicitly rather than
  // assumed, the same way #200 pins the disk-cell/drag-copy cases sharing that call site.
  it('editing a pending VMAD scalar value logs a DEBUG line naming the plugin, VMAD path, and record', async () => {
    const vmadPendingResult = {
      ...vmadEditableCompareResult,
      overrides: [{ ...vmadEditableCompareResult.overrides[0], pendingFields: { [String.raw`VMAD\MyScript\Enabled`]: true } }],
    };
    const pendingVmadChange = [{
      id: 'chg-vmad', plugin: 'MyMod.esp', fieldPath: String.raw`VMAD\MyScript\Enabled`,
      recordType: 'npc_', formKey: '000001:Fallout4.esm', newValue: true,
    }];
    renderPanel(vmadPendingResult, { plugins: mutablePlugin, changes: pendingVmadChange });
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('true'));
    fireEvent.click(screen.getByText('true'));
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]: [{ message?: string }]) => m).filter((m: { message?: string }) => m.message);
    expect(message).toContain(String.raw`VMAD\MyScript\Enabled`);
    expect(message).toContain('000001:Fallout4.esm');
  });

  // Issue #200: same rationale as the VMAD case above — Condition leaf edits share the exact
  // same stageChange call, tested explicitly rather than assumed.
  it('a Condition leaf edit logs a DEBUG line naming the plugin, condition path, and record', async () => {
    renderPanel(conditionEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('#1'));
    fireEvent.click(screen.getByText('#1').closest('tr')!.querySelector('button')!);
    const useGlobalRow = screen.getByText('Use Global').closest('tr')!;
    fireEvent.click(within(useGlobalRow).getByText('false'));
    fireEvent.click(within(useGlobalRow).getByRole('checkbox'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]: [{ message?: string }]) => m).filter((m: { message?: string }) => m.message);
    expect(message).toContain(String.raw`CTDA\Conditions\0\UseGlobal`);
    expect(message).toContain('000001:Fallout4.esm');
  });

  // Issue #203: same rationale as the pending VMAD case above — a pending Condition field edit
  // reaches the SAME handleEdit→stageChange path as the disk-cell edit above, no new/separate
  // logging code — pinned explicitly rather than assumed.
  it('editing a pending Condition field logs a DEBUG line naming the plugin, condition path, and record', async () => {
    const conditionPendingResult = {
      ...conditionEditableCompareResult,
      overrides: [{ ...conditionEditableCompareResult.overrides[0], pendingFields: { [String.raw`CTDA\Conditions\0\Operator`]: 'GreaterThan' } }],
    };
    const pendingConditionChange = [{
      id: 'chg-cond', plugin: 'MyMod.esp', fieldPath: String.raw`CTDA\Conditions\0\Operator`,
      recordType: 'cobj', formKey: '000001:Fallout4.esm', newValue: 'GreaterThan',
    }];
    renderPanel(conditionPendingResult, { plugins: mutablePlugin, changes: pendingConditionChange });
    await waitFor(() => screen.getByText('#1'));
    fireEvent.click(screen.getByText('#1').closest('tr')!.querySelector('button')!);
    const operatorRow = screen.getByText('Operator').closest('tr')!;
    fireEvent.click(within(operatorRow).getByText('GreaterThan'));
    const select = within(operatorRow).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'LessThan' } });
    fireEvent.blur(select);

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([m]: [{ message?: string }]) => m).filter((m: { message?: string }) => m.message);
    expect(message).toContain(String.raw`CTDA\Conditions\0\Operator`);
    expect(message).toContain('000001:Fallout4.esm');
  });

  it('dropping a field value onto an immutable target logs a WARN instead of a silent no-op', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const sourceCell = screen.getByText('Override Name').closest('td')!;
    const targetCell = screen.getByText('Original Name').closest('td')!;

    fireEvent.dragStart(sourceCell);
    fireEvent.drop(targetCell);

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'warn',
      message: expect.stringContaining('Fallout4.esm'),
    }));
  });

  it('Save Group logs an INFO line naming the change', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave({}));
    renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));
    fireEvent.contextMenu(screen.getByText('Staged Name'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('chg-1'),
    }));
  });

  it('Revert Group (inline ↩, single member) logs an INFO line naming the change', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));
    fireEvent.click(screen.getByText('↩'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('chg-1'),
    }));
  });

  it('Copy as New Record logs an INFO line naming source, target, and the new record', async () => {
    const createRecord = vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp' }));
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse, createRecord });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as New Record' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('000099:Mod2.esp'),
    }));
  });

  it('Remove logs an INFO line naming the plugin and record', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('MyMod.esp'),
    }));
  });

  // Issue #200: "Copy All to Pending" and "Copy as Override…" are #202's surface, deliberately
  // untouched here — both stage through the same low-level stageChange as every field edit
  // above, so this locks in that the log call lives at handleEdit/handleVmadStructOp (its
  // named callers), not inside stageChange itself, where it would leak onto every caller.
  it('Copy All to Pending does not log — out of scope, owned by #202', async () => {
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.LOG }));
  });
});
