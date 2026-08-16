import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { ExtensionToWebview } from './messages';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordSessionClient } from './RecordSessionClient';
import { DIMMED_OPACITY } from './gridStyles';

// ── shared metadata fixtures ──────────────────────────────────────────────────

const strMeta: FieldMetadata  = { name: 'Name',   type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
const intMeta: FieldMetadata = { name: 'Level', type: 'int', isArray: false, validFormKeyTypes: [], enumValues: [] };
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

const threePluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'Mod1.esp', isImmutable: false, loadOrderIndex: 1 },
  { name: 'Mod2.esp', isImmutable: false, loadOrderIndex: 2 },
];

// #163: a minimal stand-in for a client write method's typed WriteResult — the panel reads
// .ok/.status/.data/.error now, not a raw Response's .ok/.status/.statusText/.json().
function resp(status: number, body: unknown = {}) {
  return status < 400 ? { ok: true, data: body } : { ok: false, status, error: body };
}

// Issue #208: Save Group / Revert Group on a pending cell now arrive as a broadcast message
// from the native `webview/context` menu's extension-host command, not a menu-item click —
// every open record panel gets the same message and self-filters on whether it holds a pending
// change with this id. This simulates the broadcast landing on this panel.
function postPendingCellAction(
  type: typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP | typeof EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP,
  changeId: string,
) {
  window.dispatchEvent(new MessageEvent('message', { data: { type, changeId } }));
}

// Issue #209: same idea as postPendingCellAction above, for the column-header menu's five
// actions — the native menu commands resolve a target plugin (or nothing, for Remove) via a
// VS Code QuickPick (not renderable in this harness) and then broadcast, so this simulates the
// broadcast landing on this panel, self-filtered on `formKey` rather than a changeId.
function postColumnHeaderAction(msg: ExtensionToWebview) {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

// Issue #212: simulates the extension host's REVERT_GROUP_CONFIRMED reply to whichever
// OPEN_REVERT_GROUP_CONFIRM was posted most recently — same requestId-correlation shape
// nativeBridge.test.ts exercises for every bridge it covers.
function replyRevertGroupConfirmed(confirmed: boolean) {
  const call = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { requestId: string };
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: EXTENSION_TO_WEBVIEW.REVERT_GROUP_CONFIRMED, requestId: call.requestId, confirmed },
  }));
}

interface FakeOpts {
  changes?: unknown[];
  plugins?: unknown[];
  load?: RecordSessionClient['load'];
  save?: RecordSessionClient['save'];
  copyAsNew?: RecordSessionClient['copyAsNew'];
  removeOverride?: RecordSessionClient['removeOverride'];
  saveGroup?: RecordSessionClient['saveGroup'];
  revertGroup?: RecordSessionClient['revertGroup'];
  groupMembers?: RecordSessionClient['groupMembers'];
  conditionRunOnTargets?: RecordSessionClient['conditionRunOnTargets'];
}

// Issue #122: a fake record-session client. `load` returns the composite view built from the
// given compare fixture; write methods are spies tests can assert on and override.
function fakeClient(compare: unknown, opts: FakeOpts = {}): RecordSessionClient {
  const pl = (opts.plugins ?? pluginsResponse) as { name: string; isImmutable: boolean; origin?: string; inLoadOrder?: boolean }[];
  const okLoad = {
    ok: true, result: compare, changes: opts.changes ?? [], plugins: pl,
    // #272 / ADR-0036: mirrors RecordSessionClient.load()'s own columnKey()-keyed construction —
    // a fake that built this as a bare-plugin-name Set (pre-#272) would silently pass every AC5
    // test that exercises immutableSet, since the fake itself wouldn't reproduce the bug.
    immutableSet: new Set(pl.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin ?? null))),
    // #304 / ADR-0035: mirrors RecordSessionClient.load()'s own `=== false` filter — a fixture
    // that never sets inLoadOrder (every pre-#304 fixture) must default every column to
    // in-load-order, the same defensive default the real client applies.
    notInLoadOrderSet: new Set(pl.filter(p => p.inLoadOrder === false).map(p => columnKey(p.name, p.origin ?? null))),
  } as unknown as LoadResult;
  return {
    load: opts.load ?? vi.fn().mockResolvedValue(okLoad),
    save: opts.save ?? vi.fn().mockResolvedValue(resp(200, [])),
    revert: vi.fn().mockResolvedValue(resp(200, [])),
    copyTo: vi.fn().mockResolvedValue(resp(200, [])),
    removeOverride: opts.removeOverride ?? vi.fn().mockResolvedValue(resp(200, {})),
    copyAsNew: opts.copyAsNew ?? vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp' })),
    // Issue #139: group save/revert + the member-count read that decides the Revert Group confirmation.
    // groupMembers defaults to the staged changes (a group of one), the no-confirmation path.
    saveGroup: opts.saveGroup ?? vi.fn().mockResolvedValue(resp(200, { byPlugin: {}, reindexFailure: null })),
    revertGroup: opts.revertGroup ?? vi.fn().mockResolvedValue(resp(204)),
    groupMembers: opts.groupMembers ?? vi.fn().mockResolvedValue(opts.changes ?? []),
    // Issue #167: the Run On target dropdown's catalog — session-wide, fetched once on mount.
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

  // Issue #111: a cell in an immutable column never activates an *editable* input, however it is
  // clicked (spec: field-type rendering rule 6, story 17). Before this, editMode reached the
  // cells with no per-column mutability check, so a read-only column rendered inputs whose PATCH
  // the backend then rejected with a 409 "Plugin is read-only".
  //
  // Issue #226 / ADR-0034: the read-only value surface is retired, so the cell now opens no input
  // at all — the 409 this test was written to prevent stays prevented for the more direct reason
  // that nothing ever reaches a PATCH from here.
  it('a cell in an immutable column opens nothing when clicked', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));
    fireEvent.click(screen.getByText('Original Name'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

  // Issue #223 / ADR-0034: a mutable cell no longer opens on the first click — that click only
  // focuses it (xEdit's model). A second click on the now-focused cell opens the editor.
  it('a cell in a mutable column does activate an input when clicked a second time', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));
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
      winnerColumn: 'Fallout4.esm',
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
    winnerColumn: 'MyMod.esp', winnerValue: 'Override Name', cellStates: { 'MyMod.esp': 'Override' },
    conflictAll: 'Override' }],
};

// Issue #114: two sibling top-level fields, only one of which differs — proves the compare grid
// colors each row from its own field's conflictAll, not a record-wide value smeared across every
// row (the literal bug #114 reports). "Level" here is agreed by every plugin.
const twoSiblingFieldsResult = {
  conflictAll: 'Override',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Original Name' }, { metadata: intMeta, value: 5 }],
      pendingFields: {}, conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Override Name' }, { metadata: intMeta, value: 5 }],
      pendingFields: {}, conflictThis: 'Override' },
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

// Three-plugin conflict fixture for per-cell ConflictLoses/ConflictWins tests
const threePluginConflictResult = {
  conflictAll: 'Conflict',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', origin: 'Data', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Alice' }],
      pendingFields: {}, conflictThis: 'Master' },
    { formKey: '000001:Fallout4.esm', plugin: 'Mod1.esp', origin: 'Data', loadOrderIndex: 1, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Bob' }],
      pendingFields: {}, conflictThis: 'ConflictLoses', recordType: 'npc_' },
    { formKey: '000001:Fallout4.esm', plugin: 'Mod2.esp', origin: 'Data', loadOrderIndex: 2, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Charlie' }],
      pendingFields: {}, conflictThis: 'ConflictWins' },
  ],
  diffs: [{
    fieldName: 'Name',
    values: { 'Fallout4.esm': 'Alice', 'Mod1.esp': 'Bob', 'Mod2.esp': 'Charlie' },
    winnerColumn: 'Mod2.esp',
    winnerValue: 'Charlie',
    cellStates: { 'Mod1.esp': 'ConflictLoses', 'Mod2.esp': 'ConflictWins' },
  }],
};

// #272 / ADR-0036: two columns sharing a filename ('Shared.esp') but differing in origin —
// display never changes (both columns' own `.plugin` reads "Shared.esp"), so only the compound
// (plugin, origin) identity can tell them apart. Nothing loads such a pair today (blocked on
// #34), but the backend already returns this shape (ColumnKey-keyed dictionaries, per-override
// Origin) once two rows exist for one FormKey — this fixture is that shape, built by hand rather
// than through a real session load, the same way the backend's own AC5 tests do.
const sameFilenameCompareResult = {
  conflictAll: 'Conflict',
  overrides: [
    { formKey: '000001:Fallout4.esm', plugin: 'Shared.esp', origin: 'ModA', loadOrderIndex: 0, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'FromA' }],
      pendingFields: {}, conflictThis: 'Master', recordType: 'npc_' },
    { formKey: '000001:Fallout4.esm', plugin: 'Shared.esp', origin: 'ModB', loadOrderIndex: 1, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'FromB' }],
      pendingFields: {}, conflictThis: 'ConflictWins', recordType: 'npc_' },
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

describe('RecordPanel — same-filename, different-origin columns (#272 AC5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The genuinely red case for collapsedColumns: pre-#272, collapsedColumns.has(o.plugin)
  // collided on the bare "Shared.esp" filename both columns share, so collapsing one collapsed
  // (or left expanded) both.
  it('collapsing one column does not collapse the other same-filename column', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(sameFilenameCompareResult, { plugins: sameFilenamePluginsResponse });
    await waitFor(() => expect(screen.getByText('FromA')).toBeInTheDocument());
    expect(screen.getByText('FromB')).toBeInTheDocument();

    // #304: deliberately changed from the pre-#304 `getAllByText('Shared.esp')[0]` — that query
    // could no longer tell the two columns apart by text, which was itself the bug this ticket
    // fixes (ADR-0036: origin renders inline in the header exactly when two loaded copies share a
    // filename, which this fixture does).
    const colAHeader = screen.getByText('Shared.esp (ModA)');
    fireEvent.click(colAHeader); // collapses ModA's column only

    await waitFor(() => expect(screen.queryByText('FromA')).not.toBeInTheDocument());
    expect(screen.getByText('FromB')).toBeInTheDocument();
  });

  // #304 / ADR-0036: "origin appears inline in the header only when two loaded copies share a
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

  // The genuinely red case for overrideMap: pre-#272, `map[o.plugin] = o` collided on the bare
  // filename and the second override silently discarded the first — Copy as New Record would
  // have read whichever column happened to be inserted last into the map, regardless of which
  // one was actually right-clicked. Array/VMAD op targeting resolve through the identical
  // overrideMap-by-ColumnKey mechanism (RecordPanel.tsx's resolveCurrentArrayFor/handleArrayAdd/
  // handleVmadStructOp dispatch), so this is representative of that whole class, not narrowly
  // about Copy as New Record. #281: the assertion is on copyAsNew's source triple now — the
  // fields themselves are read server-side off that (plugin, origin)
  // (EditOrchestratorTests.CreateRecord_ExplicitTemplateSource_CopiesThatPluginsFields_NotWinner).
  it("Copy as New Record on one column names that column's own origin, never the other same-filename column's", async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const { client } = renderPanel(sameFilenameCompareResult, { plugins: sameFilenamePluginsResponse });
    await waitFor(() => expect(screen.getByText('FromA')).toBeInTheDocument());

    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Shared.esp', sourceOrigin: 'ModA', targetPlugin: 'Target.esp',
    });

    await waitFor(() => expect(client.copyAsNew).toHaveBeenCalledWith('000001:Fallout4.esm', 'Target.esp', 'Shared.esp', 'ModA'));
  });

  it("...and targeting the other column's origin names it instead", async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    const { client } = renderPanel(sameFilenameCompareResult, { plugins: sameFilenamePluginsResponse });
    await waitFor(() => expect(screen.getByText('FromA')).toBeInTheDocument());

    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Shared.esp', sourceOrigin: 'ModB', targetPlugin: 'Target.esp',
    });

    await waitFor(() => expect(client.copyAsNew).toHaveBeenCalledWith('000001:Fallout4.esm', 'Target.esp', 'Shared.esp', 'ModB'));
  });
});

// #304 / ADR-0035: a copy the load order does not name (#34's AddUnlistedPlugin: IsImmutable,
// Participates:false, InLoadOrder:false, always together) — distinct from a vanilla master, which
// is also immutable but stays named by the load order. Deliberately a single, non-colliding
// column here so this exercises only the reason/dimming wiring, not the origin-inline collision
// slice (#304's own "renders origin inline..." tests above).
const notInLoadOrderCompareResult = {
  conflictAll: 'OnlyOne',
  overrides: [
    {
      formKey: '000001:Solo.esp', plugin: 'Solo.esp', origin: 'ShadowMod', loadOrderIndex: 5, isWinner: false,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Shadowed value' }],
      pendingFields: {}, conflictThis: 'OnlyOne', recordType: 'npc_',
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

describe('RecordPanel — a copy the load order does not name (#304 / ADR-0035)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the column header dimmed and labeled distinctly from a vanilla master', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Solo.esp');
    renderPanel(notInLoadOrderCompareResult, { plugins: notInLoadOrderPluginsResponse });
    await waitFor(() => expect(screen.getByText('Solo.esp')).toBeInTheDocument());

    expect(screen.getByText('(not in load order)')).toBeInTheDocument();
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();

    const th = screen.getByText('Solo.esp').closest('th');
    expect(th).toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  it('does not dim a vanilla-master column (immutable, still in the load order)', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    renderPanel(compareResult, { plugins: pluginsResponse });
    await waitFor(() => expect(screen.getByText('Fallout4.esm')).toBeInTheDocument());

    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    const th = screen.getByText('Fallout4.esm').closest('th');
    expect(th).not.toHaveStyle({ opacity: String(DIMMED_OPACITY) });
  });

  // AC3: copying *out* of a read-only column must still work and take that column's own
  // content — Remove/Add Master are gated on `immutable` (package.json's `!immutable` when
  // clauses), but Copy as Override/Copy as New Record are deliberately not (modbench.package.json
  // carries no such gate for either), unchanged by this ticket. sourceOrigin is threaded
  // end to end (#281) so the backend reads *this* copy's fields, never the winner's.
  it('copying out of a not-in-load-order column still works, taking that column\'s own content', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Solo.esp');
    const { client } = renderPanel(notInLoadOrderCompareResult, { plugins: notInLoadOrderPluginsResponse });
    await waitFor(() => expect(screen.getByText('Solo.esp')).toBeInTheDocument());

    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE,
      formKey: '000001:Solo.esp', sourcePlugin: 'Solo.esp', sourceOrigin: 'ShadowMod', targetPlugin: 'Target.esp',
    });

    await waitFor(() =>
      expect(client.copyTo).toHaveBeenCalledWith('000001:Solo.esp', 'Target.esp', 'Solo.esp', 'ShadowMod'),
    );
  });
});

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

  // Issue #114: these two used to assert the record-wide CompareResult.conflictAll was smeared
  // onto the row — now each field's own diffs[].conflictAll drives its own row, exercised
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

  // The literal #114 regression guard: two sibling fields, only one differs — the agreeing
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
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  const fkPlugins = [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }];

  it('calls vscode.postMessage with type openRecord when a FormKey link is Ctrl+clicked', async () => {
    renderPanel(fkCompareResult, { plugins: fkPlugins });
    // Resolved per fkCompareResult's diff.resolutions — labeled with the #218 composite, so the
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
    // cells never activate. Issue #223: the first click only focuses it (xEdit's model); a
    // second click on the now-focused cell activates its input, which is then edited.
    fireEvent.click(screen.getByText('15'));
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
    fireEvent.click(screen.getByText('Override Name')); // #223: first click only focuses
    fireEvent.click(screen.getByText('Override Name')); // second click opens the editor

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

// Issue #209: "Add Master…" no longer a standalone button + its own hand-drawn candidate
// dropdown (ADR-0033: no standalone control once an action is right-click-reachable) — it's an
// entry on the column header's native right-click menu now, gated `isHeaderRecord && !immutable`
// and backed by a VS Code QuickPick built from the header `<th>`'s data-vscode-context (`plugin`,
// `masters`). Neither the native menu's availability nor the QuickPick's candidate list is
// renderable in this harness (see EXPECTED_COMMANDS in extension.test.ts); what's testable here
// is the context payload that backs them (covered in "column header native context menu" below)
// and that the extension host's resolved selection, once broadcast back, stages correctly.
describe('RecordPanel — Add Master (issue #86, native menu + QuickPick since #209)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const headerOpts = { plugins: headerPluginsResponse };

  it("the native modbench.columnHeader.addMaster broadcast stages the full appended masters array via save", async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const { client } = renderPanel(headerCompareResult, headerOpts);
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER,
      formKey: '000000:MyMod.esp', plugin: 'MyMod.esp', origin: 'Data', newMaster: 'DLCRobot.esm',
    });

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000000:MyMod.esp',
        'MyMod.esp',
        { masters: ['Fallout4.esm', 'DLCRobot.esm'] },
        undefined,
      ),
    );
  });

  it('a broadcast for a different formKey is ignored — this panel is not the one that was right-clicked', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const { client } = renderPanel(headerCompareResult, headerOpts);
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER,
      formKey: '000099:Other.esp', plugin: 'MyMod.esp', origin: 'Data', newMaster: 'DLCRobot.esm',
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.save).not.toHaveBeenCalled();
  });

  it('a not_append_only 422 rejection surfaces a readable message', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    const save = vi.fn().mockResolvedValue(resp(422, { fieldErrors: [{ fieldPath: 'masters', reason: 'not_append_only' }] }));
    renderPanel(headerCompareResult, { ...headerOpts, save });
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_ADD_MASTER,
      formKey: '000000:MyMod.esp', plugin: 'MyMod.esp', origin: 'Data', newMaster: 'DLCRobot.esm',
    });

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
    await waitFor(() => screen.getByText('MyMod.esp'));
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
      winnerColumn: 'MyMod.esp',
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
      winnerColumn: 'MyMod.esp',
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
      winnerColumn: 'MyMod.esp', winnerValue: 'Override Name',
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
  // Issue #222 / ADR-0034: no cursor advertises it any more — the grid rests on the default arrow.
  it('a field cell in a read-only column is draggable, with no mode to enter and no grab cursor', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));
    const cell = screen.getByText('Original Name').closest('td')!;
    expect(cell.getAttribute('draggable')).toBe('true');
    expect(cell.style.cursor).not.toBe('grab');
  });

  it('a field cell in an editable column is draggable, with no mode to enter and no grab cursor', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    expect(cell.getAttribute('draggable')).toBe('true');
    expect(cell.style.cursor).not.toBe('grab');
  });

  // Issue #111: a draggable ancestor swallows text selection inside an input — the browser
  // starts a drag instead of selecting. So a cell stops being draggable exactly while its own
  // input is active, and becomes draggable again when the input closes.
  // Issue #223: the first click only focuses the cell; the second opens its input.
  it('a cell is not draggable while its own input is active', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    fireEvent.click(screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name'));

    expect(screen.getByDisplayValue('Override Name')).toBeInTheDocument();
    expect(cell.getAttribute('draggable')).toBe('false');
  });

  it('a cell becomes draggable again once its input is dismissed', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    fireEvent.click(screen.getByText('Override Name'));
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
    fireEvent.click(screen.getByText('Override Name'));

    expect(sibling.getAttribute('draggable')).toBe('true');
  });
});

// ── Cell focus (issue #222 / ADR-0034) ────────────────────────────────────────
//
// DiffRow.test.tsx already covers the per-cell mechanics (tabIndex, real DOM focus, the row/cell
// paint) with a single row in isolation. What only RecordPanel can prove — it is the one
// component that sees every row — is the panel-wide invariant: exactly one cell focused at a
// time, and that focus outlives the re-renders staging/refresh cause.
const secondFieldMeta: FieldMetadata = { name: 'Description', type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };

const twoFieldResult = {
  conflictAll: 'NoConflict',
  overrides: [
    {
      formKey: '000001:Fallout4.esm', plugin: 'Fallout4.esm', loadOrderIndex: 0, isWinner: false, editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'Name A' }, { metadata: secondFieldMeta, value: 'Desc A' }],
      pendingFields: {}, conflictThis: 'Master',
    },
    {
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 1, isWinner: true, editorId: 'TestNPC',
      fields: [{ metadata: strMeta, value: 'Name B' }, { metadata: secondFieldMeta, value: 'Desc B' }],
      pendingFields: {}, conflictThis: 'ConflictWins',
    },
  ],
  diffs: [
    { fieldName: 'Name', values: { 'Fallout4.esm': 'Name A', 'MyMod.esp': 'Name B' }, winnerColumn: 'MyMod.esp', winnerValue: 'Name B', cellStates: {} },
    { fieldName: 'Description', values: { 'Fallout4.esm': 'Desc A', 'MyMod.esp': 'Desc B' }, winnerColumn: 'MyMod.esp', winnerValue: 'Desc B', cellStates: {} },
  ],
};

describe('RecordPanel — cell focus (issue #222 / ADR-0034)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clicking a cell in a different row moves focus there, leaving the previous row unhighlighted', async () => {
    renderPanel(twoFieldResult);
    await waitFor(() => screen.getByText('Name B'));

    fireEvent.click(screen.getByText('Name B'));
    const nameRow = screen.getByText('Name').closest('tr')!;
    expect(nameRow.style.boxShadow).toContain('var(--vscode-focusBorder');

    fireEvent.click(screen.getByText('Desc B'));
    const descRow = screen.getByText('Description').closest('tr')!;
    expect(descRow.style.boxShadow).toContain('var(--vscode-focusBorder');
    // Exactly one cell/row focused across the panel — the previous row lost it.
    expect(nameRow.style.boxShadow).toBe('');
  });

  it('clicking a cell in a different column of the same row moves focus there, leaving the previous cell unmarked', async () => {
    renderPanel(twoFieldResult);
    await waitFor(() => screen.getByText('Name A'));
    // Issue #226: a click no longer replaces either cell's text node (Fallout4.esm's is
    // immutable and opens nothing; MyMod.esp's is mutable but a single click only focuses,
    // ADR-0034), so capturing the <td> reference before the click is no longer load-bearing —
    // kept anyway since it costs nothing and stays correct regardless of what a future click
    // handler does to the text node.
    const fo4Cell = screen.getByText('Name A').closest('td')!;

    fireEvent.click(screen.getByText('Name A')); // Fallout4.esm — immutable, still focusable
    expect(fo4Cell.style.boxShadow).toContain('var(--vscode-focusBorder');

    const myModCell = screen.getByText('Name B').closest('td')!; // captured before the click, same reason as fo4Cell above
    fireEvent.click(screen.getByText('Name B')); // MyMod.esp, same row
    expect(myModCell.style.boxShadow).toContain('var(--vscode-focusBorder');
    expect(fo4Cell.style.boxShadow).toBe('');
  });

  it('focus on a cell survives the refresh a staged edit through it triggers', async () => {
    const { client } = renderPanel(twoFieldResult);
    await waitFor(() => screen.getByText('Name B'));
    const loadCallsBefore = (client.load as ReturnType<typeof vi.fn>).mock.calls.length;

    // Issue #223: the first click focuses (already true per #222); the second, on the
    // now-focused cell, opens the editor.
    fireEvent.click(screen.getByText('Name B'));
    fireEvent.click(screen.getByText('Name B'));
    const input = screen.getByDisplayValue('Name B');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(client.save).toHaveBeenCalled());
    await waitFor(() => expect((client.load as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(loadCallsBefore));
    // The fake client's load() always returns the original fixture, so the text reverts —
    // that's fine, the point is the focused cell/row survive the refresh that just happened.
    await waitFor(() => screen.getByText('Name B'));

    const nameRow = screen.getByText('Name').closest('tr')!;
    expect(nameRow.style.boxShadow).toContain('var(--vscode-focusBorder');
    const myModCell = screen.getByText('Name B').closest('td')!;
    expect(myModCell.style.boxShadow).toContain('var(--vscode-focusBorder');
    expect(myModCell).toHaveFocus();
  });

  it('focus resets when LOAD_RECORD navigates to a different record', async () => {
    renderPanel(twoFieldResult);
    await waitFor(() => screen.getByText('Name B'));
    fireEvent.click(screen.getByText('Name B'));
    expect(screen.getByText('Name').closest('tr')!.style.boxShadow).toContain('var(--vscode-focusBorder');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() => screen.getByText('Name B'));
    expect(screen.getByText('Name').closest('tr')!.style.boxShadow).toBe('');
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
      .map((call: unknown[]) => call[0] as { message?: string }).filter((m) => m.message);
    expect(message).toContain('Bounds');
    expect(message).toContain('000001:Fallout4.esm');
  });

  // Issue #206: dropping a field's value back onto the exact cell it was dragged from is a
  // no-op gesture, not an edit — it must stage nothing and log nothing, regardless of whether
  // that cell's column happens to be mutable or immutable.
  it('dropping a field onto the cell it was dragged from (a mutable column) stages nothing and logs nothing', async () => {
    vi.mocked(vscode.postMessage).mockClear();
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Override Name'));

    const cell = screen.getByText('Override Name').closest('td')!;
    fireEvent.dragStart(cell);
    fireEvent.drop(cell);

    // Let any (incorrect) async staging work run before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.save).not.toHaveBeenCalled();
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.LOG }),
    );
  });

  // The self-drop guard must run before the immutable-column guard: dropping back onto an
  // immutable source cell is still a no-op gesture (silent), not a rejection (WARN) — those are
  // different things even though both end in "nothing staged".
  it('dropping a field onto the cell it was dragged from (an immutable column) stages nothing and does not log a WARN', async () => {
    vi.mocked(vscode.postMessage).mockClear();
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Original Name'));

    const cell = screen.getByText('Original Name').closest('td')!;
    fireEvent.dragStart(cell);
    fireEvent.drop(cell);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.save).not.toHaveBeenCalled();
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.LOG }),
    );
  });

  // Distinct from a self-drop: two different mutable columns that happen to already hold the
  // same value are still a real cross-column copy — the guard must key off plugin identity, not
  // value equality, or this would wrongly get swallowed too.
  it('dropping onto a different mutable column still stages, even when its value already equals the source', async () => {
    const identicalValueResult = {
      conflictAll: 'NoConflict',
      overrides: [
        {
          formKey: '000001:Fallout4.esm', plugin: 'Mod1.esp', loadOrderIndex: 1, isWinner: false,
          editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Same Name' }],
          pendingFields: {}, conflictThis: 'Master',
        },
        {
          formKey: '000001:Fallout4.esm', plugin: 'Mod2.esp', loadOrderIndex: 2, isWinner: true,
          editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Same Name' }],
          pendingFields: {}, conflictThis: 'ConflictWins',
        },
      ],
      diffs: [
        {
          fieldName: 'Name',
          values: { 'Mod1.esp': 'Same Name', 'Mod2.esp': 'Same Name' },
          winnerColumn: 'Mod2.esp', winnerValue: 'Same Name',
          cellStates: {},
        },
      ],
    };
    const { client } = renderPanel(identicalValueResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getAllByText('Same Name'));

    const cells = screen.getAllByText('Same Name');
    fireEvent.dragStart(cells[0].closest('td')!);
    fireEvent.drop(cells[1].closest('td')!);

    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        '000001:Fallout4.esm',
        'Mod2.esp',
        { Name: 'Same Name' },
        undefined,
      ),
    );
  });
});

// ── Column header native context menu (issue #3, native since #209; consolidated in #202) ─────
//
// The column-header menu (Copy as Override… / Copy as New Record / Remove / Add Master) is VS
// Code's own `webview/context` menu now, gated on the header `<th>`'s
// data-vscode-context — not a rendered `<ul role="menu">` (#208's migration switch applied
// here too: no `onContextMenu`/`preventDefault()` on the `<th>` any more). Its own availability
// (the `when` clauses in package.json) isn't renderable in this harness — see EXPECTED_COMMANDS
// in extension.test.ts. What's testable here is the context payload that backs those `when`
// clauses and the QuickPick's candidate list; the actions themselves are covered by the
// broadcast-simulation describes below (same shape as #208's Save/Revert Group tests).

describe('RecordPanel — column header native context menu', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  function contextOf(pluginText: string) {
    return JSON.parse(screen.getByText(pluginText).closest('th')!.getAttribute('data-vscode-context')!);
  }

  it('a mutable column header carries webviewSection/formKey/plugin/immutable=false, suppressing Cut/Copy/Paste', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(contextOf('MyMod.esp')).toMatchObject({
      webviewSection: 'columnHeader', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp',
      immutable: false, preventDefaultContextMenuItems: true,
    });
  });

  // Remove's `when` clause (package.json) keys off this — absent for an immutable column,
  // matching today's disabled Remove item (acceptance: "Remove stays disabled/absent for an
  // immutable plugin, as today").
  it('an immutable column header carries immutable: true', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Fallout4.esm'));
    expect(contextOf('Fallout4.esm').immutable).toBe(true);
  });

  it("the header record's own column carries isHeaderRecord: true and its current masters — Add Master's `when`/QuickPick key off these", async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    renderPanel(headerCompareResult, { plugins: headerPluginsResponse });
    await waitFor(() => screen.getByText('MyMod.esp'));
    const ctx = contextOf('MyMod.esp');
    expect(ctx.isHeaderRecord).toBe(true);
    expect(ctx.masters).toEqual(['Fallout4.esm']);
  });

  it('a non-header record column carries isHeaderRecord: false', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    expect(contextOf('MyMod.esp').isHeaderRecord).toBe(false);
  });
});

// ── Remove (issue #3, renamed from "Remove Override" in #177; native menu since #209) ─────────

describe('RecordPanel — Remove', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the native menu's Remove broadcast stages a delete via removeOverride", async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
    });

    await waitFor(() =>
      expect(client.removeOverride).toHaveBeenCalledWith('000001:Fallout4.esm', 'MyMod.esp'),
    );
  });

  it('a broadcast for a different formKey is ignored — this panel is not the one that was right-clicked', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE, formKey: '000099:Other.esm', plugin: 'MyMod.esp', origin: 'Data',
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.removeOverride).not.toHaveBeenCalled();
  });
});

// ── Copy as New Record (issue #3, native menu + QuickPick since #209) ─────────

describe('RecordPanel — Copy as New Record', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  // #281: one backend call — the template-source triple names the right-clicked column; the
  // backend reads that copy's fields and derives the record type from the template, so there is
  // no create-blank-then-patch choreography left to assert on.
  it("the native menu's broadcast copies the source column as a new record in one call", async () => {
    const copyAsNew = vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp', groupId: 'g1' }));
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse, copyAsNew });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() =>
      expect(client.copyAsNew).toHaveBeenCalledWith('000001:Fallout4.esm', 'Mod2.esp', 'Mod1.esp', 'Data'),
    );
    expect(client.save).not.toHaveBeenCalled();
  });
});

// ── Copy as Override… (issue #176; native menu since #209 reuses modbench.copyAsOverrideInto;
//    #202 sources the right-clicked column, not the winner) ───────────────────────────────────
//
// Formerly a standalone button, then (#176) a hand-drawn menu item sharing PluginTargetPicker;
// now the same handleCopyTo flow, triggered by the extension host's modbench.copyAsOverrideInto
// — the same command the plugins tree already used, extended (#209) to accept the column
// header's record identity instead of only a tree node, and to resolve its target via a native
// QuickPick instead of a positioned in-webview list. #202: the broadcast now also carries
// `sourcePlugin` (the right-clicked column) — handleCopyTo forwards it to `client.copyTo`
// unchanged, so the backend (not this webview) decides whose fields actually get copied
// (EditOrchestratorTests.CopyRecordTo_ExplicitSourcePlugin_CopiesThatPluginsFields_NotWinner).

describe('RecordPanel — Copy as Override…', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the native modbench.copyAsOverrideInto broadcast copies the right-clicked column into the QuickPick's chosen target via copyTo", async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() =>
      expect(client.copyTo).toHaveBeenCalledWith('000001:Fallout4.esm', 'Mod2.esp', 'Mod1.esp', 'Data'),
    );
  });

  // Mod1.esp is NOT the winner in threePluginConflictResult (Mod2.esp is) — proves the
  // right-clicked column is what's forwarded, not whatever plugin happens to be winning.
  it('forwards the right-clicked column even when it is not the winning plugin', async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Fallout4.esm', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() =>
      expect(client.copyTo).toHaveBeenCalledWith('000001:Fallout4.esm', 'Mod2.esp', 'Fallout4.esm', 'Data'),
    );
  });

  it('a broadcast for a different formKey is ignored — this panel is not the one that was right-clicked', async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE,
      formKey: '000099:Other.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.copyTo).not.toHaveBeenCalled();
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
    winnerColumn: 'MyMod.esp', winnerValue: '1',
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
    winnerColumn: 'MyMod.esp', winnerValue: '000019:Fallout4.esm',
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
    winnerColumn: 'MyMod.esp', winnerValue: '000019:Fallout4.esm',
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

    // The staged FormKey resolves, so it renders as the #218 composite and is a link (a button), so
    // Ctrl+click follows the reference — a plain <span> could not.
    const link = screen.getByText('SomeRace [0001F4:Fallout4.esm]');
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
  // cell too, flags included. Issue #232: opening now takes a second click (or F2/double click)
  // on the same terms as a disk cell — a bare double click here proves that without needing to
  // reach into RecordPanel's own focus state.
  it('clicking a pending flags value opens its multi-select editor, the same as a disk cell', async () => {
    renderPanel(pendingFlagsResult);
    await waitFor(() => screen.getByText('Flags'));

    fireEvent.doubleClick(screen.getByText('Fire, Ice'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(3); // Fire, Ice, Shock
  });
});

// ── Pending column save / revert (issue #139) ──────────────────────────────────
//
// The Pending column's actions, every one scoped to a ChangeGroup (ADR-0029). A staged edit
// to Name on the mutable column, with a matching pending change so the group actions
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
    winnerColumn: 'MyMod.esp', winnerValue: 'Original Name',
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
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    // Issue #212: cleared so each test's own assertions about OPEN_REVERT_GROUP_CONFIRM
    // (posted/not-posted) aren't polluted by another test's earlier calls on this shared mock.
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  // Issue #208: the pending cell's right-click menu is now VS Code's own `webview/context`
  // contribution — no rendered menu items to assert on (VS Code exposes no menu contents to
  // either test harness). What's left to verify from here is that Save Group / Revert Group
  // still land on the right change and preserve every existing outcome, now triggered by the
  // extension-host broadcast a native menu-item click produces (postPendingCellAction) instead
  // of a menu-item click. The cell's own `data-vscode-context` gating is covered at the
  // DiffRow/VmadSection/ConditionSection unit level; the new command ids are covered by
  // EXPECTED_COMMANDS in the integration test.

  it('a pending value in the main grid carries the data-vscode-context gating the native menu, through the full render path', async () => {
    renderPanel(pendingNameResult, { changes: soloChange });
    await waitFor(() => screen.getByText('Staged Name'));

    const cell = screen.getByText('Staged Name').closest('td')!;
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'pendingCell', changeId: 'chg-1', preventDefaultContextMenuItems: true,
    });
  });

  it('Save Group saves that change\'s component and refreshes the grid', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave({}));
    const { client } = renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, 'chg-1');

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

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, 'chg-1');

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

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, 'chg-1');

    await waitFor(() => expect(screen.getByText(/index is now stale/)).toBeInTheDocument());
    // A completed-but-stale save is a warning, not a failure — it must not claim the save failed.
    expect(screen.queryByText(/Partial save/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not write/)).not.toBeInTheDocument();
  });

  // Issue #208: a Save Group broadcast for a changeId this panel doesn't hold (i.e. it landed
  // on some other open record panel) must be a silent no-op, not an attempt against the wrong
  // record.
  it('a Save Group broadcast for a changeId this panel does not hold is a silent no-op', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave({}));
    renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, 'chg-not-mine');

    expect(saveGroup).not.toHaveBeenCalled();
  });

  // Issue #212: the multi-member confirmation is now a native modal warning — the webview posts
  // OPEN_REVERT_GROUP_CONFIRM (asserted via vscode.postMessage, same as every other
  // extension-host bridge) and awaits a REVERT_GROUP_CONFIRMED reply correlated by requestId,
  // simulated here the same way nativeBridge.test.ts simulates it for every other bridge.
  it('reverting the whole group on confirm calls revertGroup, not the single-change endpoint', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    const { client } = renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-1');
    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM }),
    ));
    replyRevertGroupConfirmed(true);

    await waitFor(() => expect(revertGroup).toHaveBeenCalledWith('chg-1'));
    expect(client.revert).not.toHaveBeenCalled();
  });

  it('a dismissed/cancelled confirmation reverts nothing', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-1');
    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM }),
    ));
    replyRevertGroupConfirmed(false);

    await Promise.resolve();
    expect(revertGroup).not.toHaveBeenCalled();
  });

  it('Revert Group on a multi-member group opens the native confirmation listing every linked edit, and does not revert until confirmed', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(twoMemberGroup);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-1');

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM,
      detail: expect.stringContaining('BoundWeapon'),
    })));
    expect(revertGroup).not.toHaveBeenCalled();
  });

  it('Revert Group on a group of one reverts with no confirmation', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-1');

    await waitFor(() => expect(revertGroup).toHaveBeenCalledWith('chg-1'));
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_REVERT_GROUP_CONFIRM }),
    );
  });

  // Issue #208: same self-filter guarantee as Save Group above.
  it('a Revert Group broadcast for a changeId this panel does not hold is a silent no-op', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));

    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-not-mine');

    expect(groupMembers).not.toHaveBeenCalled();
    expect(revertGroup).not.toHaveBeenCalled();
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
    winnerColumn: 'MyMod.esp', winnerValue: '00013918:Fallout4.esm',
    cellStates: { 'MyMod.esp': 'Override' },
  }],
};

const soloChangeFk = [{
  id: 'chg-1', plugin: 'MyMod.esp', fieldPath: 'Race', recordType: 'npc_', formKey: '000001:Fallout4.esm',
  resolutions: { '': { state: 'ResolvedValidType', recordType: 'race', editorId: 'SomeRace' } },
}];

// Issue #208: Reveal in Pending Changes Tree moved off the webview↔extension message bridge
// entirely — resolving a changeId to a tree node is extension-host-only work
// (PendingChangesTreeProvider/TreeView), so the native `modbench.pendingCell.reveal` command
// calls recordPanelMessageRouter's exported `revealPendingChange` directly and never posts
// anything to/from this webview. That behavior (happy path, no-longer-pending logs not throws,
// resolution error reports) is covered by recordPanelMessageRouter.test.ts's own
// `revealPendingChange` describe block; there's nothing left to exercise from the webview side.
describe('RecordPanel — Pending column right-click reveal (issue #203, moved from plain-click)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Ctrl+click on a pending FormKey value still posts openRecord', async () => {
    renderPanel(pendingFkResult, { changes: soloChangeFk });
    await waitFor(() => screen.getByText('SomeRace [00099999:MyMod.esp]'));

    fireEvent.click(screen.getByText('SomeRace [00099999:MyMod.esp]'), { ctrlKey: true });

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.OPEN_RECORD,
      formKey: '00099999:MyMod.esp',
    });
  });
});

// ── Pending column direct editing (issue #203, reverses #140; gesture updated by #232/#242) ─────
//
// A pending value's cell is directly editable, on the same terms as a disk cell — plain click no
// longer reveals the change in the Pending Changes tree; that gesture moved to the right-click
// menu tested above. Issue #232: opening it now takes a second click, F2, or a double click, the
// same as a disk cell (a bare first click only focuses). Issue #242: for a `string` field (as
// `Name` is here) double click now reaches the extended editor, not the inline one — matching a
// disk cell of the same type — so the inline-commit test below uses a first click (focus) then a
// second click (open) instead.

describe('RecordPanel — Pending column direct editing (issue #203/#232)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.mocked(vscode.postMessage).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  // Issue #242: `Name` is a `string` field, so a double click now reaches the extended editor —
  // matching a disk cell of the same type — rather than the inline input this test used to pin
  // (extendedFieldEditor.ts's tab identity carries a disk/pending discriminant, so this doesn't
  // alias the disk cell's own tab).
  it('a double click on a pending value opens the extended editor, on the same terms as a disk cell', async () => {
    renderPanel(pendingNameResult, { changes: soloChange });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.doubleClick(screen.getByText('Staged Name'));

    expect(screen.queryByDisplayValue('Staged Name')).not.toBeInTheDocument();
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: WEBVIEW_TO_EXTENSION.OPEN_EXTENDED_EDITOR, value: 'Staged Name', column: 'pending',
    }));
  });

  // Issue #200/#203: a pending-cell edit reaches the SAME handleEdit→stageChange path a disk-cell
  // edit does — no new/separate logging code — so it logs DEBUG identically (pinned explicitly,
  // matching how #200 already pinned this for the drag-copy path sharing the same call site).
  // Issue #242: reaches the inline editor via a first click (focus) then a second click on the
  // now-focused cell — double click moved onto the extended editor (see the test above), same
  // "second click / F2 opens inline" rule a disk cell's string field follows.
  it('committing an edit on a pending value via the inline editor stages it and logs DEBUG the same as a disk-cell edit', async () => {
    const save = vi.fn().mockResolvedValue(resp(200, []));
    renderPanel(pendingNameResult, { changes: soloChange, save });
    await waitFor(() => screen.getByText('Staged Name'));

    fireEvent.click(screen.getByText('Staged Name')); // focus
    fireEvent.click(screen.getByText('Staged Name')); // second click on the already-focused cell
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
    fireEvent.click(screen.getByText('Override Name')); // #223: first click only focuses
    fireEvent.click(screen.getByText('Override Name')); // second click opens the editor
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
    fireEvent.click(screen.getByText('Override Name')); // #223: first click only focuses
    fireEvent.click(screen.getByText('Override Name')); // second click opens the editor
    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED });
  });

  it('the native Copy as Override… broadcast posts pendingChanged once staged', async () => {
    const { client } = renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() => expect(client.copyTo).toHaveBeenCalledWith('000001:Fallout4.esm', 'Mod2.esp', 'Mod1.esp', 'Data'));
    expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED });
  });

  it('the native Remove broadcast posts pendingChanged once staged', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
    });

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('the native Copy as New Record broadcast posts pendingChanged once staged', async () => {
    const copyAsNew = vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp' }));
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse, copyAsNew });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('Save Group posts pendingChanged once the save completes', async () => {
    const saveGroup = vi.fn().mockResolvedValue(okSave({}));
    renderPanel(pendingNameResult, { changes: soloChange, saveGroup });
    await waitFor(() => screen.getByText('Staged Name'));
    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, 'chg-1');

    await waitFor(() =>
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: WEBVIEW_TO_EXTENSION.PENDING_CHANGED }),
    );
  });

  it('Revert Group posts pendingChanged once the revert completes', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));
    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-1');

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
    winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {},
  }],
  vmad: {
    scripts: [{
      name: 'MyScript', flags: { 'MyMod.esp': 'Local' }, winnerColumn: 'MyMod.esp', cellStates: {},
      properties: [{
        name: 'Enabled', kind: 'scalar', values: { 'MyMod.esp': false }, types: { 'MyMod.esp': 'Bool' },
        winnerColumn: 'MyMod.esp', cellStates: {}, children: null,
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
    winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {},
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
        winnerColumn: 'MyMod.esp', cellStates: {}, fieldCellStates: {},
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
    fireEvent.click(screen.getByText('Override Name')); // #223: first click only focuses
    fireEvent.click(screen.getByText('Override Name')); // second click opens the editor
    const input = screen.getByDisplayValue('Override Name');
    fireEvent.change(input, { target: { value: 'Changed Name' } });
    fireEvent.blur(input);

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { message?: string }).filter((m) => m.message);
    expect(message).toContain('Name');
    expect(message).toContain('000001:Fallout4.esm');
  });

  it('a rejected field edit does not log', async () => {
    const save = vi.fn().mockResolvedValue(resp(409, {}));
    renderPanel(compareResult, { save });
    await waitFor(() => screen.getByText('Override Name'));
    fireEvent.click(screen.getByText('Override Name')); // #223: first click only focuses
    fireEvent.click(screen.getByText('Override Name')); // second click opens the editor
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
    // Issue #231: MyScript now lives one level below the always-present "Scripts (VMAD)"
    // wrapper row (an ordinary struct row, not a hand-drawn section) — expand it first.
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('false'));
    // Issue #231: VMAD leaves now go through the field grid's real focus model (ADR-0034) rather
    // than VmadSection's own always-open (isFocused defaulted true) shortcut — first click
    // focuses, second click on the now-focused cell opens it, same as any other bool leaf.
    fireEvent.click(screen.getByText('false'));
    fireEvent.click(screen.getByText('false'));
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { message?: string }).filter((m) => m.message);
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
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('true'));
    // Issue #232: same real focus model as every other value cell now — first click focuses,
    // second click on the now-focused cell opens it.
    fireEvent.click(screen.getByText('true'));
    fireEvent.click(screen.getByText('true'));
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { message?: string }).filter((m) => m.message);
    expect(message).toContain(String.raw`VMAD\MyScript\Enabled`);
    expect(message).toContain('000001:Fallout4.esm');
  });

  // Issue #200: same rationale as the VMAD case above — Condition leaf edits share the exact
  // same stageChange call, tested explicitly rather than assumed.
  it('a Condition leaf edit logs a DEBUG line naming the plugin, condition path, and record', async () => {
    renderPanel(conditionEditableCompareResult, { plugins: mutablePlugin });
    // Issue #231: a condition is now an ordinary array-element row, labeled "[i]" like any other
    // unsorted array element rather than the deleted ConditionSection's own "#1" convention.
    await waitFor(() => screen.getByText('Conditions'));
    fireEvent.click(screen.getByText('Conditions').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('[0]'));
    fireEvent.click(screen.getByText('[0]').closest('tr')!.querySelector('button')!);
    const useGlobalRow = screen.getByText('Use Global').closest('tr')!;
    // Issue #231: same real focus model as the VMAD case above — first click focuses, second
    // click on the now-focused cell opens it.
    fireEvent.click(within(useGlobalRow).getByText('false'));
    fireEvent.click(within(useGlobalRow).getByText('false'));
    fireEvent.click(within(useGlobalRow).getByRole('checkbox'));

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'debug',
      message: expect.stringContaining('MyMod.esp'),
    }));
    const [{ message }] = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { message?: string }).filter((m) => m.message);
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
    await waitFor(() => screen.getByText('Conditions'));
    fireEvent.click(screen.getByText('Conditions').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('[0]'));
    fireEvent.click(screen.getByText('[0]').closest('tr')!.querySelector('button')!);
    const operatorRow = screen.getByText('Operator').closest('tr')!;
    // Issue #232: same real focus model as every other value cell now — first click focuses,
    // second click on the now-focused cell opens it.
    fireEvent.click(within(operatorRow).getByText('GreaterThan'));
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
      .map((call: unknown[]) => call[0] as { message?: string }).filter((m) => m.message);
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
    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_SAVE_GROUP, 'chg-1');

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('chg-1'),
    }));
  });

  it('Revert Group (single member) logs an INFO line naming the change', async () => {
    const revertGroup = vi.fn().mockResolvedValue(resp(204));
    const groupMembers = vi.fn().mockResolvedValue(soloChange);
    renderPanel(pendingNameResult, { changes: soloChange, revertGroup, groupMembers });
    await waitFor(() => screen.getByText('Staged Name'));
    postPendingCellAction(EXTENSION_TO_WEBVIEW.PENDING_CELL_REVERT_GROUP, 'chg-1');

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('chg-1'),
    }));
  });

  it('the native Copy as New Record broadcast logs an INFO line naming source, target, and the new record', async () => {
    const copyAsNew = vi.fn().mockResolvedValue(resp(200, { formKey: '000099:Mod2.esp' }));
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse, copyAsNew });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_NEW_RECORD,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('000099:Mod2.esp'),
    }));
  });

  it('the native Remove broadcast logs an INFO line naming the plugin and record', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_REMOVE_OVERRIDE, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
    });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('MyMod.esp'),
    }));
  });

  // Issue #202: Copy as Override's own log call was deliberately deferred by #200 to this
  // ticket ("Copy All to Pending" and "Copy as Override…" are #202's surface") — now it logs
  // INFO on success, matching Remove/Copy as New Record's own pattern above. "Copy All to
  // Pending" itself is gone entirely (the consolidated three-action menu), so there is no longer
  // a sibling "does not log" case to pin down here.
  it('the native Copy as Override… broadcast logs an INFO line naming source, target, and record', async () => {
    renderPanel(threePluginConflictResult, { plugins: threePluginsResponse });
    await waitFor(() => screen.getByText('Bob'));
    postColumnHeaderAction({
      type: EXTENSION_TO_WEBVIEW.COLUMN_HEADER_COPY_AS_OVERRIDE,
      formKey: '000001:Fallout4.esm', sourcePlugin: 'Mod1.esp', sourceOrigin: 'Data', targetPlugin: 'Mod2.esp',
    });

    await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.LOG,
      level: 'info',
      message: expect.stringContaining('Mod2.esp'),
    }));
  });
});

// ── VMAD structural ops via the right-click menu (issue #231) ──────────────────
//
// Mirrors #227's array-op broadcast tests: the extension host has no live reference into this
// webview's React state, so its native commands (Add/Remove Script, Remove Property, Add
// Property) broadcast to every open record panel and each self-filters on `formKey`. Add
// Property's own dialog is the one exception with async UI (#229's "one deliberate exception" —
// a webview modal, not a QuickPick), so its own test drives the dialog after the broadcast opens it.

describe('RecordPanel — VMAD structural-op right-click menu (issue #231)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  function postVmadOp(msg: ExtensionToWebview) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }

  it('the "Scripts (VMAD)" wrapper row carries the vmadScripts context on a mutable column', async () => {
    renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    const cell = screen.getByText('Scripts (VMAD)').closest('tr')!.querySelectorAll('td')[1];
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'vmadScripts', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      preventDefaultContextMenuItems: true,
    });
  });

  it('a script row carries the vmadScript context on a mutable column', async () => {
    renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    const cell = screen.getByText('MyScript').closest('tr')!.querySelectorAll('td')[1];
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'vmadScript', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript',
      currentFlags: 'Local', preventDefaultContextMenuItems: true,
    });
  });

  it('a property row carries the vmadProperty context on a mutable column', async () => {
    renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('Enabled'));
    const cell = screen.getByText('Enabled').closest('tr')!.querySelectorAll('td')[1];
    expect(JSON.parse(cell.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'vmadProperty', formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data',
      scriptName: 'MyScript', propName: 'Enabled', preventDefaultContextMenuItems: true,
    });
  });

  it('VMAD_ADD_SCRIPT stages an add_script op', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({ type: EXTENSION_TO_WEBVIEW.VMAD_ADD_SCRIPT, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', name: 'NewScript' });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      { 'VMAD\\NewScript': { op: 'add_script', name: 'NewScript', flags: 'Local', properties: [] } },
      'vmad_struct_op',
    ));
  });

  it('VMAD_REMOVE_SCRIPT stages a remove_script op', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({ type: EXTENSION_TO_WEBVIEW.VMAD_REMOVE_SCRIPT, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript' });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { 'VMAD\\MyScript': { op: 'remove_script' } }, 'vmad_struct_op',
    ));
  });

  it('VMAD_REMOVE_PROPERTY stages a remove_property op', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({
      type: EXTENSION_TO_WEBVIEW.VMAD_REMOVE_PROPERTY, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript', propName: 'Enabled',
    });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { 'VMAD\\MyScript\\Enabled': { op: 'remove_property' } }, 'vmad_struct_op',
    ));
  });

  it('a VMAD op broadcast for a different formKey is ignored', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({ type: EXTENSION_TO_WEBVIEW.VMAD_REMOVE_SCRIPT, formKey: '000099:Other.esm', plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript' });
    expect(client.save).not.toHaveBeenCalled();
  });

  it('VMAD_OPEN_ADD_PROPERTY opens the Add Property dialog, and confirming stages an add_property op', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({ type: EXTENSION_TO_WEBVIEW.VMAD_OPEN_ADD_PROPERTY, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript' });

    await waitFor(() => screen.getByText('Add property'));
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'NewProp' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      { 'VMAD\\MyScript\\NewProp': { op: 'add_property', type: 'Int', name: 'NewProp', flags: 'Edited', value: 0 } },
      'vmad_struct_op',
    ));
  });

  // Issue #231 (review): Set Script Flags/Set Property Flags restore a capability that worked on
  // main (VmadSection's always-visible flag `<select>`s) and regressed to unreachable when that
  // section was deleted — the "remove and re-add" fallback the spec briefly claimed doesn't
  // actually work, since Add Script/Add Property hardcode default flag values.
  it('VMAD_SET_SCRIPT_FLAGS stages a set_flags op against the script', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({
      type: EXTENSION_TO_WEBVIEW.VMAD_SET_SCRIPT_FLAGS, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript', flags: 'Removed',
    });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { 'VMAD\\MyScript': { op: 'set_flags', flags: 'Removed' } }, 'vmad_struct_op',
    ));
  });

  it('VMAD_SET_PROPERTY_FLAGS stages a set_flags op against the property', async () => {
    const { client } = renderPanel(vmadEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postVmadOp({
      type: EXTENSION_TO_WEBVIEW.VMAD_SET_PROPERTY_FLAGS, formKey: '000001:Fallout4.esm',
      plugin: 'MyMod.esp', origin: 'Data', scriptName: 'MyScript', propName: 'Enabled', flags: 'Removed',
    });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { 'VMAD\\MyScript\\Enabled': { op: 'set_flags', flags: 'Removed' } }, 'vmad_struct_op',
    ));
  });
});

// Issue #231 (review, design call): a collapsed Condition row shows xEdit's own one-line prose
// summary (conditionTreeAdapter.ts's collapsedSummary, DiffRow.tsx's struct branch), not the
// generic "{…}" every other struct row is content with.
describe('RecordPanel — collapsed Condition row shows the xEdit-style summary (issue #231 design call)', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders "RunOn.Function(...) Op Comparison" instead of "{…}" on the collapsed row', async () => {
    renderPanel(conditionEditableCompareResult, { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Conditions'));
    fireEvent.click(screen.getByText('Conditions').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('Subject.GetStageDone = 3'));
    expect(screen.queryByText('{…}')).not.toBeInTheDocument();
  });
});

// ── Array ops on VMAD/Condition rows via the right-click menu broadcast (issue #231) ──────────
//
// The broadcast handlers (modbench.array.*, extension.ts) resolve "the current array" through
// `overrideMap[plugin].fields` — which only ever lists *reflected* fields. A VMAD/Condition array
// row is never one of those (SchemaReflector excludes conditions, #178; VMAD isn't reflection at
// all), so this is the regression-proof slice for the fix that taught `resolveCurrentArrayFor`
// to also search the synthesized diff tree: getting it wrong silently replaces the *whole* array
// with the new/edited element alone, rather than restaging the one that changed.

function twoConditions() {
  const condition = (comparisonFloat: number) => ({
    function: 'GetStageDone', operator: 'EqualTo', or: false, runOnTarget: 'Subject',
    runOnReference: null, useGlobal: false, comparisonFloat, comparisonGlobal: null, parameters: [],
  });
  return {
    conflictAll: 'OnlyOne', hasVmad: false,
    overrides: [{
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Test Name' }],
      pendingFields: {}, conflictThis: 'OnlyOne',
    }],
    diffs: [{ fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' }, winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {} }],
    conditions: {
      groups: [{
        fieldPath: 'Conditions',
        conditions: [
          { index: 0, perPlugin: { 'MyMod.esp': condition(1) }, winnerColumn: 'MyMod.esp', cellStates: {}, fieldCellStates: {} },
          { index: 1, perPlugin: { 'MyMod.esp': condition(2) }, winnerColumn: 'MyMod.esp', cellStates: {}, fieldCellStates: {} },
        ],
      }],
    },
  };
}

describe('RecordPanel — Condition array ops via the right-click menu broadcast preserve siblings (issue #231)', () => {
  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  function postArrayOp(type: string, extra: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldName: 'Conditions', ...extra },
    }));
  }

  it('ARRAY_REMOVE on condition #0 restages the list with only #0 dropped, not the whole list emptied', async () => {
    const { client } = renderPanel(twoConditions(), { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Conditions'));
    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, { index: 0 });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      { Conditions: [expect.objectContaining({ comparisonFloat: 2 })] },
      undefined,
    ));
  });

  it('ARRAY_ADD appends a default condition, keeping both existing ones', async () => {
    const { client } = renderPanel(twoConditions(), { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Conditions'));
    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_ADD, {});

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      {
        Conditions: [
          expect.objectContaining({ comparisonFloat: 1 }),
          expect.objectContaining({ comparisonFloat: 2 }),
          expect.objectContaining({ function: 'GetIsID' }),
        ],
      },
      undefined,
    ));
  });

  it('ARRAY_MOVE_DOWN on condition #0 swaps the two, keeping both', async () => {
    const { client } = renderPanel(twoConditions(), { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Conditions'));
    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN, { index: 0 });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      { Conditions: [expect.objectContaining({ comparisonFloat: 2 }), expect.objectContaining({ comparisonFloat: 1 })] },
      undefined,
    ));
  });
});

function vmadStructListResult() {
  const instance = (x: number, y: number) => [
    { name: 'X', type: 'Int', intValue: x },
    { name: 'Y', type: 'Int', intValue: y },
  ];
  const member = (name: string, value: number) => ({
    name, kind: 'scalar', values: { 'MyMod.esp': value }, types: { 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: {},
  });
  const instanceDiff = (x: number, y: number) => ({
    name: '', kind: 'struct', values: {}, types: {}, winnerColumn: 'MyMod.esp', cellStates: {},
    children: [member('X', x), member('Y', y)],
  });
  return {
    conflictAll: 'OnlyOne', hasVmad: true,
    overrides: [{
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Test Name' }],
      pendingFields: {}, conflictThis: 'OnlyOne',
    }],
    diffs: [{ fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' }, winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {} }],
    vmad: {
      scripts: [{
        name: 'MyScript', flags: { 'MyMod.esp': 'Local' }, winnerColumn: 'MyMod.esp', cellStates: {},
        properties: [{
          name: 'Points', kind: 'structList',
          values: {}, types: { 'MyMod.esp': 'ArrayOfStruct' }, winnerColumn: 'MyMod.esp', cellStates: {},
          raw: { 'MyMod.esp': [instance(1, 2), instance(3, 4)] },
          children: [instanceDiff(1, 2), instanceDiff(3, 4)],
        }],
      }],
    },
  };
}

describe('RecordPanel — VMAD structList (ArrayOfStruct) array ops via the right-click menu broadcast (issue #231)', () => {
  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  function postArrayOp(type: string, extra: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldName: String.raw`VMAD\MyScript\Points`, ...extra },
    }));
  }

  it('ARRAY_REMOVE on instance #0 restages the raw node array with only that instance dropped', async () => {
    const { client } = renderPanel(vmadStructListResult(), { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_REMOVE, { index: 0 });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      { 'VMAD\\MyScript\\Points': [[{ name: 'X', type: 'Int', intValue: 3 }, { name: 'Y', type: 'Int', intValue: 4 }]] },
      undefined,
    ));
  });

  it('ARRAY_MOVE_DOWN on instance #0 swaps the two raw node instances', async () => {
    const { client } = renderPanel(vmadStructListResult(), { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    postArrayOp(EXTENSION_TO_WEBVIEW.ARRAY_MOVE_DOWN, { index: 0 });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp',
      {
        'VMAD\\MyScript\\Points': [
          [{ name: 'X', type: 'Int', intValue: 3 }, { name: 'Y', type: 'Int', intValue: 4 }],
          [{ name: 'X', type: 'Int', intValue: 1 }, { name: 'Y', type: 'Int', intValue: 2 }],
        ],
      },
      undefined,
    ));
  });

  it('no arrayParent data-vscode-context is offered for a structList row — Add has no safe default yet (known gap)', async () => {
    renderPanel(vmadStructListResult(), { plugins: mutablePlugin });
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('Points'));

    const cells = Array.from(document.querySelectorAll('td[data-vscode-context]'));
    const arrayParentCells = cells.filter(c => JSON.parse(c.getAttribute('data-vscode-context')!).webviewSection === 'arrayParent');
    expect(arrayParentCells).toHaveLength(0);
  });
});

function vmadScalarArrayResult() {
  const elem = (v: number) => ({
    name: '', kind: 'scalar', values: { 'MyMod.esp': v }, types: { 'MyMod.esp': 'Int' }, winnerColumn: 'MyMod.esp', cellStates: {},
  });
  return {
    conflictAll: 'OnlyOne', hasVmad: true,
    overrides: [{
      formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', loadOrderIndex: 0, isWinner: true,
      editorId: 'TestNPC', fields: [{ metadata: strMeta, value: 'Test Name' }],
      pendingFields: {}, conflictThis: 'OnlyOne',
    }],
    diffs: [{ fieldName: 'Name', values: { 'MyMod.esp': 'Test Name' }, winnerColumn: 'MyMod.esp', winnerValue: 'Test Name', cellStates: {} }],
    vmad: {
      scripts: [{
        name: 'MyScript', flags: { 'MyMod.esp': 'Local' }, winnerColumn: 'MyMod.esp', cellStates: {},
        properties: [{
          name: 'Levels', kind: 'array',
          values: {}, types: { 'MyMod.esp': 'ArrayOfInt' }, winnerColumn: 'MyMod.esp', cellStates: {},
          children: [elem(1), elem(2)],
        }],
      }],
    },
  };
}

// Issue #231 (review): the right-click menu's own Add broadcast used to resolve its target field
// purely through `fieldMetaMap`'s *top-level* keys, which a nested VMAD property's own wire path
// was never one of (unlike a Condition list, which is a top-level synthesized entry, so its own
// Add already worked via the broadcast — the prior describe block above) — `findMetaByWirePath`
// (RecordPanel.tsx) now walks down from the VMAD tree's own top-level entry (`meta.fields`/
// `meta.elementType`, the same struct-child/array-element resolution `buildRows` already does
// during render) so the broadcast finds it too. Insert (the keyboard accelerator onto the same
// menu item, DiskCell) never shared that limitation — it calls the row's own `onArrayAdd` closure
// directly, already carrying the correct element type from the render that built it.
describe('RecordPanel — VMAD array-of-scalars Add: keyboard and the right-click broadcast both stage (issue #231, review)', () => {
  beforeEach(() => vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm'));
  afterEach(() => vi.unstubAllGlobals());

  async function expandToLevels() {
    await waitFor(() => screen.getByText('Scripts (VMAD)'));
    fireEvent.click(screen.getByText('Scripts (VMAD)').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('MyScript'));
    fireEvent.click(screen.getByText('MyScript').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('Levels'));
  }

  it('Insert on the focused Levels row stages a new default-valued element via the keyboard', async () => {
    const { client } = renderPanel(vmadScalarArrayResult(), { plugins: mutablePlugin });
    await expandToLevels();
    const levelsRow = screen.getByText('Levels').closest('tr')!;
    const mutableCell = levelsRow.querySelectorAll('td')[1];
    fireEvent.keyDown(mutableCell, { key: 'Insert' });

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { 'VMAD\\MyScript\\Levels': [1, 2, 0] }, undefined,
    ));
  });

  it('the right-click menu\'s ARRAY_ADD broadcast also stages a new default-valued element for this row', async () => {
    const { client } = renderPanel(vmadScalarArrayResult(), { plugins: mutablePlugin });
    await expandToLevels();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: EXTENSION_TO_WEBVIEW.ARRAY_ADD, formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldName: String.raw`VMAD\MyScript\Levels` },
    }));

    await waitFor(() => expect(client.save).toHaveBeenCalledWith(
      '000001:Fallout4.esm', 'MyMod.esp', { 'VMAD\\MyScript\\Levels': [1, 2, 0] }, undefined,
    ));
  });
});
