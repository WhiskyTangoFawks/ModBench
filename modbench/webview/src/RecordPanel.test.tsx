import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { ScalarCell, FormKeyCell, CheckErrorIcon, RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { FieldMetadata } from './types';
import type { LoadResult, RecordSessionClient } from './RecordSessionClient';

// Issue #122: the panel talks to the backend only through an injected client. A client whose
// picker search is stubbed is enough for the FormKeyCell unit tests, which never open the
// picker (they assert link / navigation gestures, not search results).
const stubClient = { searchRecords: vi.fn().mockResolvedValue([]) } as unknown as RecordSessionClient;

// ── shared metadata fixtures ──────────────────────────────────────────────────

const strMeta: FieldMetadata  = { name: 'Name',   type: 'string', isArray: false, validFormKeyTypes: [], enumValues: [] };
const intMeta: FieldMetadata  = { name: 'Level',  type: 'int',    isArray: false, validFormKeyTypes: [], enumValues: [] };
const floatMeta: FieldMetadata = { name: 'Weight', type: 'float',  isArray: false, validFormKeyTypes: [], enumValues: [] };
const boolMeta: FieldMetadata = { name: 'Female', type: 'bool',   isArray: false, validFormKeyTypes: [], enumValues: [] };
const enumMeta: FieldMetadata = {
  name: 'Gender', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumValues: ['Male', 'Female', 'None'],
};
const fkMeta: FieldMetadata = {
  name: 'Race', type: 'formKey', isArray: false, validFormKeyTypes: ['race'], enumValues: [],
};

// ── ScalarCell ────────────────────────────────────────────────────────────────

describe('ScalarCell — read-only column', () => {
  it('shows the string value', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('shows "—" for null', () => {
    render(<ScalarCell value={null} meta={strMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows numeric value as text', () => {
    render(<ScalarCell value={42} meta={intMeta} editable={false} onCommit={vi.fn()} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

// Issue #111: an editable cell renders as text until it is clicked — reading conflicts at a
// glance is the grid's primary job, so only the clicked cell becomes an input (xEdit's
// toEditOnClick). Commit or blur returns it to text.
describe('ScalarCell — editable column renders text until clicked', () => {
  it('renders text, not an input, before it is clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('swaps to a text input for string type when clicked', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dogmeat').type).toBe('text');
  });

  it('returns to text on blur', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('renders a number input for int type when clicked', () => {
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('5'));
    expect(screen.getByDisplayValue('5').type).toBe('number');
  });

  it('calls onCommit with a number (not a string) when int input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
    expect(typeof onCommit.mock.calls[0][0]).toBe('number');
  });

  it('calls onCommit with a float when float input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={1.5} meta={floatMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('1.5'));
    const input = screen.getByDisplayValue('1.5');
    fireEvent.change(input, { target: { value: '3.14' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(3.14);
  });

  it('swaps to a checkbox for bool type when clicked', () => {
    render(<ScalarCell value={false} meta={boolMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('false'));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox').checked).toBe(false);
  });

  // Activating a bool must not toggle it: a stray click would otherwise stage a change.
  it('does not commit merely by activating a bool cell', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('false'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('calls onCommit with true when the activated bool checkbox is clicked', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('false'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('swaps to a select with all enum options when clicked', () => {
    render(<ScalarCell value="Male" meta={enumMeta} editable={true} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('Male'));
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Male' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Female' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
  });

  it('calls onCommit with Enter key on a text input', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="old" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('old'));
    const input = screen.getByDisplayValue('old');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
  });
});

// Issue #111: click-to-activate puts every cell one mis-click away from staging. A change whose
// old value equals its new value is not an edit — it is noise in the Pending Changes tree, and
// it drags a whole ChangeGroup's dependency closure along with it (ADR-0028). The bool path
// guarded this from the start; every type needs it, because any cell can now be mis-clicked.
describe('ScalarCell — a no-op edit stages nothing', () => {
  it('does not commit when a text cell is activated and blurred without editing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.blur(screen.getByDisplayValue('Dogmeat'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when a number cell is activated and blurred without editing', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    fireEvent.blur(screen.getByDisplayValue('5'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when an enum cell is activated and blurred without changing the selection', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Male" meta={enumMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Male'));
    fireEvent.blur(screen.getByRole('combobox'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit when a text edit is typed and then reverted by hand before blur', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    const input = screen.getByDisplayValue('Dogmeat');
    fireEvent.change(input, { target: { value: 'Dogmeat!' } });
    fireEvent.change(input, { target: { value: 'Dogmeat' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not commit on Enter when the value is unchanged', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="Dogmeat" meta={strMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Dogmeat'));
    fireEvent.keyDown(screen.getByDisplayValue('Dogmeat'), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The guard must not swallow a real edit that happens to round-trip through the same string.
  it('still commits a genuine change', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editable={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByText('5'));
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
  });
});

// ── FormKeyCell ───────────────────────────────────────────────────────────────

// Issue #111: one gesture split, uniform across the grid — plain click edits (opens the
// picker), Ctrl+click follows the reference. This is the collision the mode was silently
// resolving: click used to mean "navigate" in view mode and "open picker" in edit mode.
describe('FormKeyCell — read-only column', () => {
  it('shows "—" when value is null', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the formKey string as a link', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('Ctrl+click navigates to the referenced record', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
  });

  it('plain click does nothing — no navigation, no picker', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Search EditorID…')).not.toBeInTheDocument();
  });
});

describe('FormKeyCell — editable column', () => {
  it('shows "—" when value is null, not a picker button', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search EditorID…')).not.toBeInTheDocument();
  });

  it('shows the current formKey as a link at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('plain click opens the FormKey picker inline', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('—'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
  });

  it('plain click on a cell with a value opens the picker, not navigation', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Ctrl+click navigates instead of opening the picker', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={true} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'), { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
    expect(screen.queryByPlaceholderText('Search EditorID…')).not.toBeInTheDocument();
  });
});

// ── CheckErrorIcon ───────────────────────────────────────────────────────────

// Issue #111: the link affordance appears on Ctrl-hover only, and only where the reference
// actually goes somewhere — without the guard the gesture is invisible, and with it advertised
// on a dangling reference it lies. Mirrors xEdit's vstViewCheckHotTrack, which sets
// Allow := Assigned(lLinksTo) and requires VK_CONTROL.
//
// The resolve guard is checkError: the backend emits one ("<Error: Could not be resolved>")
// exactly when a FormLink is not in the record index, and it is already threaded to the cell.
// It is a proxy, not the real thing — see #141 and the note in medit-record-editor.md.
describe('FormKeyCell — Ctrl-hover link affordance', () => {
  afterEach(() => { fireEvent.keyUp(window, { key: 'Control' }); });

  it('shows no link affordance at rest', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    expect(link.style.textDecoration).toBe('none');
  });

  it('shows the link affordance when Ctrl is held and the cell is hovered', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('underline');
    expect(link.style.cursor).toBe('pointer');
  });

  it('shows no link affordance on Ctrl-hover when the reference does not resolve', () => {
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} checkError="[FFFFFF:Dangling.esm] <Error: Could not be resolved>" />);
    const link = screen.getByText('FFFFFF:Dangling.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    expect(link.style.textDecoration).toBe('none');
  });

  // The affordance and the gesture agree: a link that does not look followable is not
  // followable. Otherwise Ctrl+click would navigate to a record that is not in the index.
  it('Ctrl+click does not navigate when the reference does not resolve', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="FFFFFF:Dangling.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={onOpen} onCommit={vi.fn()} checkError="[FFFFFF:Dangling.esm] <Error: Could not be resolved>" />);
    fireEvent.click(screen.getByText('FFFFFF:Dangling.esm'), { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drops the affordance again when Ctrl is released', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    const link = screen.getByText('000019:Fallout4.esm');
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.mouseEnter(link);
    fireEvent.keyUp(window, { key: 'Control' });
    expect(link.style.textDecoration).toBe('none');
  });
});

describe('CheckErrorIcon', () => {
  it('renders nothing when checkError is null or undefined', () => {
    const { container: a } = render(<CheckErrorIcon checkError={null} />);
    expect(a.textContent).toBe('');
    const { container: b } = render(<CheckErrorIcon checkError={undefined} />);
    expect(b.textContent).toBe('');
  });

  it('renders a warning icon with the message as its title', () => {
    render(<CheckErrorIcon checkError="[FFFFFF:Dangling.esm] <Error: Could not be resolved>" />);
    const icon = screen.getByText('⚠');
    expect(icon).toHaveAttribute('title', '[FFFFFF:Dangling.esm] <Error: Could not be resolved>');
  });
});

describe('FormKeyCell — checkError', () => {
  it('shows no warning icon when checkError is absent', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('shows a warning icon with the checkError as its title in view mode', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editable={false} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} checkError="dangling reference" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });

  it('shows a warning icon in edit mode too', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editable={true} client={stubClient} onOpen={vi.fn()} onCommit={vi.fn()} checkError="null not allowed" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'null not allowed');
  });
});

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

  it('offers Copy as Override… on a mutable column with no mode to enter first', async () => {
    renderPanel(compareResult);
    await waitFor(() => expect(screen.getByText('Copy as Override…')).toBeInTheDocument());
  });

  // Issue #136: the panel's Save button called POST /plugins/{plugin}/save — a route the
  // backend does not implement and will not, because ADR-0029 scopes save to a ChangeGroup,
  // never to a plugin. A control that claims to save but 404s is a false affordance
  // (ADR-0026), so it is deleted rather than de-gated. Saving lives in the Pending Changes
  // tree; the Pending column's group-scoped Save/Revert is its own ticket.
  it('offers no per-plugin Save — save is scoped to a ChangeGroup, not a plugin', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Copy as Override…'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('offers no Copy as Override… on an immutable column', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('(read-only)'));
    // Fallout4.esm is immutable, MyMod.esp is not — exactly one column gets the action.
    expect(screen.getAllByText('Copy as Override…')).toHaveLength(1);
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
    await waitFor(() => screen.getByText('00013918:Fallout4.esm'));
    fireEvent.click(screen.getByText('00013918:Fallout4.esm'), { ctrlKey: true });
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
    const save = vi.fn().mockResolvedValue(resp(422, [{ fieldPath: 'masters', reason: 'not_append_only' }]));
    renderPanel(headerCompareResult, { ...headerOpts, save });
    await waitFor(() => screen.getByText('Add Master…'));
    fireEvent.click(screen.getByText('Add Master…'));
    fireEvent.mouseDown(screen.getByText('DLCRobot.esm'));

    await waitFor(() =>
      expect(screen.getByText(/masters can only be appended to/)).toBeInTheDocument(),
    );
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
});

// ── Column header context menu (issue #3) ─────────────────────────────────────

describe('RecordPanel — column header context menu', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('right-clicking a plugin column header shows Copy All to Pending, Copy as New Record, and Remove Override', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as New Record' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toBeInTheDocument();
  });

  it('Remove Override is disabled on an immutable plugin column, enabled on a mutable one', async () => {
    renderPanel(compareResult);
    await waitFor(() => screen.getByText('Fallout4.esm'));

    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toHaveAttribute('aria-disabled', 'true');

    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).not.toHaveAttribute('aria-disabled', 'true');
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

// ── Remove Override (issue #3) ────────────────────────────────────────────────

describe('RecordPanel — Remove Override', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clicking Remove Override on a mutable column stages a delete via removeOverride', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Override' }));

    await waitFor(() =>
      expect(client.removeOverride).toHaveBeenCalledWith('000001:Fallout4.esm', 'MyMod.esp'),
    );
  });

  it('Remove Override is disabled and inert on an immutable column — no delete call is made', async () => {
    const { client } = renderPanel(compareResult);
    await waitFor(() => screen.getByText('Fallout4.esm'));
    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Override' }));

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
    renderPanel(pendingFormKeyResult);
    await waitFor(() => screen.getByText('Race'));

    // The staged FormKey is labelled with its FormKey string and is a link (a button), so
    // Ctrl+click follows the reference — a plain <span> could not.
    const link = screen.getByText('0001F4:Fallout4.esm');
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

  // Guard, not a red-driver: routing the pending value through renderCell (which is capable of
  // rendering editable controls) newly risks the pending cell becoming editable. Rule 6 / the
  // issue require it stay read-only — clicking must never surface an input.
  it('keeps the pending cell non-editable — clicking surfaces no input', async () => {
    renderPanel(pendingFlagsResult);
    await waitFor(() => screen.getByText('Flags'));

    fireEvent.click(screen.getByText('Fire, Ice'));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
