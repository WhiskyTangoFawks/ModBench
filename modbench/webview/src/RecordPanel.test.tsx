import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordSessionClient } from './RecordSessionClient';

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


// #163: a minimal stand-in for a client write method's typed WriteResult — the panel reads
// .ok/.status/.data/.error now, not a raw Response's .ok/.status/.statusText/.json().
interface FakeOpts {
  plugins?: unknown[];
  // #308 / ADR-0035: defaults to true (settled, no banner) — the overwhelmingly common fixture
  // case, and the one every pre-#308 test implicitly assumed. The two banner-specific tests below
  // override it.
  conflictsComputed?: boolean;
  load?: RecordSessionClient['load'];
  conditionRunOnTargets?: RecordSessionClient['conditionRunOnTargets'];
}

// Issue #122: a fake record-session client. `load` returns the composite view built from the
// given compare fixture; write methods are spies tests can assert on and override.
function fakeClient(compare: unknown, opts: FakeOpts = {}): RecordSessionClient {
  const pl = (opts.plugins ?? pluginsResponse) as { name: string; isImmutable: boolean; origin?: string; inLoadOrder?: boolean }[];
  const okLoad = {
    ok: true, result: compare, plugins: pl,
    // #272 / ADR-0036: mirrors RecordSessionClient.load()'s own columnKey()-keyed construction —
    // a fake that built this as a bare-plugin-name Set (pre-#272) would silently pass every AC5
    // test that exercises immutableSet, since the fake itself wouldn't reproduce the bug.
    immutableSet: new Set(pl.filter(p => p.isImmutable).map(p => columnKey(p.name, p.origin ?? null))),
    // #304 / ADR-0035: mirrors RecordSessionClient.load()'s own `=== false` filter — a fixture
    // that never sets inLoadOrder (every pre-#304 fixture) must default every column to
    // in-load-order, the same defensive default the real client applies.
    notInLoadOrderSet: new Set(pl.filter(p => p.inLoadOrder === false).map(p => columnKey(p.name, p.origin ?? null))),
    conflictsComputed: opts.conflictsComputed ?? true,
  } as unknown as LoadResult;
  return {
    load: opts.load ?? vi.fn().mockResolvedValue(okLoad),
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

});

// ── postMessage wiring ────────────────────────────────────────────────────────


// Override fixture — conflictAll: 'Override', second plugin has conflictThis: 'Override'

// Issue #114: two sibling top-level fields, only one of which differs — proves the compare grid
// colors each row from its own field's conflictAll, not a record-wide value smeared across every
// row (the literal bug #114 reports). "Level" here is agreed by every plugin.

// Three-plugin conflict fixture for per-cell ConflictLoses/ConflictWins tests

// #272 / ADR-0036: two columns sharing a filename ('Shared.esp') but differing in origin —
// display never changes (both columns' own `.plugin` reads "Shared.esp"), so only the compound
// (plugin, origin) identity can tell them apart. Nothing loads such a pair today (blocked on
// #34), but the backend already returns this shape (ColumnKey-keyed dictionaries, per-override
// Origin) once two rows exist for one FormKey — this fixture is that shape, built by hand rather
// than through a real session load, the same way the backend's own AC5 tests do.

