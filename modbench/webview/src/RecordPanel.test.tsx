import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { ScalarCell, FormKeyCell, CheckErrorIcon, RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';
import type { FieldMetadata } from './types';

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

describe('ScalarCell — view mode', () => {
  it('shows the string value', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('Dogmeat')).toBeInTheDocument();
  });

  it('shows "—" for null', () => {
    render(<ScalarCell value={null} meta={strMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows numeric value as text', () => {
    render(<ScalarCell value={42} meta={intMeta} editMode={false} onCommit={vi.fn()} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

describe('ScalarCell — edit mode', () => {
  it('renders a text input for string type', () => {
    render(<ScalarCell value="Dogmeat" meta={strMeta} editMode={true} onCommit={vi.fn()} />);
    expect(screen.getByDisplayValue('Dogmeat')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dogmeat').type).toBe('text');
  });

  it('renders a number input for int type', () => {
    render(<ScalarCell value={5} meta={intMeta} editMode={true} onCommit={vi.fn()} />);
    expect(screen.getByDisplayValue('5').type).toBe('number');
  });

  it('calls onCommit with a number (not a string) when int input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={5} meta={intMeta} editMode={true} onCommit={onCommit} />);
    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
    expect(typeof onCommit.mock.calls[0][0]).toBe('number');
  });

  it('calls onCommit with a float when float input is blurred', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={1.5} meta={floatMeta} editMode={true} onCommit={onCommit} />);
    const input = screen.getByDisplayValue('1.5');
    fireEvent.change(input, { target: { value: '3.14' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(3.14);
  });

  it('renders a checkbox for bool type', () => {
    render(<ScalarCell value={false} meta={boolMeta} editMode={true} onCommit={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox').checked).toBe(false);
  });

  it('calls onCommit with true when bool checkbox is clicked', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value={false} meta={boolMeta} editMode={true} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('renders a select with all enum options', () => {
    render(<ScalarCell value="Male" meta={enumMeta} editMode={true} onCommit={vi.fn()} />);
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('Male')).toBeInTheDocument();
    expect(screen.getByText('Female')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('calls onCommit with Enter key on a text input', () => {
    const onCommit = vi.fn();
    render(<ScalarCell value="old" meta={strMeta} editMode={true} onCommit={onCommit} />);
    const input = screen.getByDisplayValue('old');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('new');
  });
});

// ── FormKeyCell ───────────────────────────────────────────────────────────────

describe('FormKeyCell — view mode', () => {
  it('shows "—" when value is null', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editMode={false} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the formKey string as a clickable link', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editMode={false} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('calls onOpen with the formKey when the link is clicked', () => {
    const onOpen = vi.fn();
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editMode={false} port={5172} onOpen={onOpen} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByText('000019:Fallout4.esm'));
    expect(onOpen).toHaveBeenCalledWith('000019:Fallout4.esm');
  });
});

describe('FormKeyCell — edit mode', () => {
  it('shows a "click to pick" prompt when value is null', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editMode={true} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText(/click to pick/i)).toBeInTheDocument();
  });

  it('shows the current formKey on the picker button when a value is set', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editMode={true} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.getByText('000019:Fallout4.esm')).toBeInTheDocument();
  });

  it('opens FormKeyPicker inline when the pick button is clicked', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editMode={true} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
  });
});

// ── CheckErrorIcon ───────────────────────────────────────────────────────────

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
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editMode={false} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} />);
    expect(screen.queryByText('⚠')).not.toBeInTheDocument();
  });

  it('shows a warning icon with the checkError as its title in view mode', () => {
    render(<FormKeyCell value="000019:Fallout4.esm" meta={fkMeta} editMode={false} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} checkError="dangling reference" />);
    expect(screen.getByText('⚠')).toHaveAttribute('title', 'dangling reference');
  });

  it('shows a warning icon in edit mode too', () => {
    render(<FormKeyCell value={null} meta={fkMeta} editMode={true} port={5172} onOpen={vi.fn()} onCommit={vi.fn()} checkError="null not allowed" />);
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

function makeFetch() {
  return vi.fn((url: string) => {
    if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(compareResult) };
    if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
    if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
}

describe('RecordPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows "No record selected." when no formKey is set', () => {
    vi.stubGlobal('mEditFormKey', '');
    render(<RecordPanel />);
    expect(screen.getByText('No record selected.')).toBeInTheDocument();
  });

  it('shows the record title with editorId and formKey after loading', async () => {
    render(<RecordPanel />);
    await waitFor(() => expect(screen.getByText(/TestNPC \[000001:Fallout4\.esm\]/)).toBeInTheDocument());
  });

  it('shows field names from the diff table', async () => {
    render(<RecordPanel />);
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
  });

  it('shows field values for each override column', async () => {
    render(<RecordPanel />);
    await waitFor(() => expect(screen.getByText('Original Name')).toBeInTheDocument());
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('shows an Edit button in view mode', async () => {
    render(<RecordPanel />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeInTheDocument());
  });

  it('switches to View button and shows inputs when Edit is clicked', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('View')).toBeInTheDocument();
    // Name field is a string — there should now be an input with the value
    expect(screen.getByDisplayValue('Original Name')).toBeInTheDocument();
  });

  it('shows Save button for mutable plugins in edit mode', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('shows (read-only) label and no Save button for immutable plugins', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    expect(screen.getAllByText('Save')).toHaveLength(1); // only MyMod.esp gets a Save
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
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(fkCompareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve([{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }]) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
    render(<RecordPanel />);
    await waitFor(() => expect(screen.getByText('Race')).toBeInTheDocument());
  });
});

describe('RecordPanel — conflict color coding', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies green row background when conflictAll is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(overrideCompareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr')!;
    expect(row.style.backgroundColor).toBe('rgba(76, 175, 80, 0.20)');
  });

  it('applies orange row background when conflictAll is Conflict', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Name'));
    const row = screen.getByText('Name').closest('tr')!;
    expect(row.style.backgroundColor).toBe('rgba(255, 152, 0, 0.20)');
  });

  it('applies orange cell background when cellStates is ConflictWins', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(255, 152, 0, 0.18)');
  });

  it('applies red cell background and red text when cellStates is ConflictLoses', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(threePluginConflictResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve([
        { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
        { name: 'Mod1.esp', isImmutable: false, loadOrderIndex: 1 },
        { name: 'Mod2.esp', isImmutable: false, loadOrderIndex: 2 },
      ]) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Bob'));
    const cell = screen.getByText('Bob').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(244, 67, 54, 0.18)');
    expect(cell.style.color).toBe('rgba(244, 67, 54, 1)');
  });

  it('applies green cell background when cellStates is Override', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(overrideCompareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Override Name'));
    const cell = screen.getByText('Override Name').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(76, 175, 80, 0.18)');
  });

  it('column header background reflects CompareOverride.conflictThis', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Override Name'));
    // MyMod.esp header: conflictThis = 'ConflictWins' → orange background in the <th>
    const header = screen.getByText('MyMod.esp').closest('th')!;
    expect(header.style.backgroundColor).toBe('rgba(255, 152, 0, 0.35)');
  });
});

describe('RecordPanel — postMessage wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(fkCompareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve([{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }]) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
    vi.mocked(vscode.postMessage).mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('calls vscode.postMessage with type openRecord when a FormKey link is clicked', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('00013918:Fallout4.esm'));
    fireEvent.click(screen.getByText('00013918:Fallout4.esm'));
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: WEBVIEW_TO_EXTENSION.OPEN_RECORD,
      formKey: '00013918:Fallout4.esm',
    });
  });

  it('re-fetches with new formKey when a loadRecord message arrives from the extension', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('TestNPC [000001:Fallout4.esm]'));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('000002%3AFallout4.esm'),
      ),
    );
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
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(structCompareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('struct parent row renders ▶ toggle and {…} placeholder in value cells', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Bounds'));
    expect(screen.getByText('▶')).toBeInTheDocument();
    expect(screen.getAllByText('{…}').length).toBeGreaterThan(0);
  });

  it('child rows appear after clicking ▶ toggle', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => expect(screen.getByText('X')).toBeInTheDocument());
    expect(screen.getByText('Y')).toBeInTheDocument();
  });

  it('child row for X shows values from sub-field', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('toggle collapses child rows when clicked again', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));
    fireEvent.click(screen.getByText('▼'));
    await waitFor(() => expect(screen.queryByText('X')).not.toBeInTheDocument());
  });

  it('child row X has correct cell background from cellStates (Override = green)', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('15'));
    const cell = screen.getByText('15').closest('td')!;
    expect(cell.style.backgroundColor).toBe('rgba(76, 175, 80, 0.18)');
  });

  it('child edit calls handleEdit with parent field name and merged struct', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => screen.getByText('▶'));
    fireEvent.click(screen.getByText('▶'));
    await waitFor(() => screen.getByText('X'));

    // Find the input for the X sub-field in the Fallout4.esm column (value 10)
    const inputFor10 = screen.getByDisplayValue('10');
    fireEvent.change(inputFor10, { target: { value: '99' } });
    fireEvent.blur(inputFor10);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('"Bounds"'),
        }),
      ),
    );

    const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    );
    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as {
      plugin: string;
      fields: Record<string, unknown>;
    };
    expect(body.fields['Bounds']).toMatchObject({ X: 99 });
  });
});

// ── 422 ProblemDetails surfacing (issue #85: ESL-ineligible / read-only) ─────

describe('RecordPanel — 422 ProblemDetails detail is surfaced', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return {
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          // ProblemDetails object (not the reference-error array) — e.g. the ESL rejection reason.
          json: () => Promise.resolve({
            detail: "'MyMod.esp' can't be an ESL: 1 FormID(s) fall outside the ESL range (0x001–0xFFF): 001000:MyMod.esp",
          }),
        };
      }
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(compareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the ProblemDetails detail text when a stage is rejected with 422', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));

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

function makeHeaderFetch() {
  return vi.fn((url: string) => {
    if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(headerCompareResult) };
    if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
    if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(headerPluginsResponse) };
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
}

describe('RecordPanel — Add Master picker (issue #86)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('F1: shows "Add Master…" only in edit mode, on the header record', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeHeaderFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Add Master…')).toBeInTheDocument();
  });

  it('F1: does not show "Add Master…" on a non-header record', async () => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
  });

  it("F2: picker offers loaded plugins minus already-mastered ones and the record's own plugin", async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeHeaderFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Add Master…'));

    // Fallout4.esm is already a master → excluded. DLCRobot.esm is loaded, not yet a master →
    // offered. MyMod.esp (the record's own plugin) never appears as a candidate.
    expect(screen.getByText('DLCRobot.esm')).toBeInTheDocument();
    expect(screen.queryByText('Fallout4.esm')).not.toBeInTheDocument();
  });

  it('F3: selecting a plugin stages the full appended masters array via PATCH', async () => {
    const fetchMock = makeHeaderFetch();
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Add Master…'));
    fireEvent.mouseDown(screen.getByText('DLCRobot.esm'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    );
    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as {
      plugin: string;
      fields: Record<string, unknown>;
    };
    expect(body.plugin).toBe('MyMod.esp');
    expect(body.fields['masters']).toEqual(['Fallout4.esm', 'DLCRobot.esm']);
  });

  it('F3: a not_append_only 422 rejection surfaces a readable message', async () => {
    vi.stubGlobal('mEditFormKey', '000000:MyMod.esp');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return {
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          json: () => Promise.resolve([{ fieldPath: 'masters', reason: 'not_append_only' }]),
        };
      }
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(headerCompareResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(headerPluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
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
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(noOpPendingResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not yellow-highlight the pending cell when pending value equals disk value', async () => {
    render(<RecordPanel />);
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
    vi.stubGlobal('mEditBackendPort', 15172);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resets savingPlugin when LOAD_RECORD arrives while a save is in-flight', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/save')) return new Promise(() => {}); // never resolves
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(compareResult) };
      if (String(url).includes('/changes')) return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins')) return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));

    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => screen.getByText('Save'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => screen.getByText('Saving…'));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000002:Fallout4.esm' },
      }));
    });

    // After LOAD_RECORD, new record loads with same plugins; clicking Edit should not show "Saving…"
    await waitFor(() => screen.getByText(/TestNPC/));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    expect(screen.getByText('Save')).not.toBeDisabled();
  });

  it('re-fetches data when LOAD_RECORD arrives with the same formKey', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<RecordPanel />);
    await waitFor(() => screen.getByText(/TestNPC/));
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:Fallout4.esm' },
      }));
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
    // Panel should recover from Loading… and show data
    await waitFor(() => screen.getByText(/TestNPC/));
  });

  it('clears error and shows data after a successful refresh following a load failure', async () => {
    let shouldFail = true;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/compare')) {
        if (shouldFail) return { ok: false, status: 500, statusText: 'Internal Server Error' };
        return { ok: true, json: () => Promise.resolve(compareResult) };
      }
      if (String(url).includes('/changes')) return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins')) return { ok: true, json: () => Promise.resolve(pluginsResponse) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    }));

    render(<RecordPanel />);
    await waitFor(() => expect(screen.getByText(/Error:/)).toBeInTheDocument());

    shouldFail = false;
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
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clicking a plugin column header chip collapses that column, hiding its field values', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Original Name'));

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();
    // the chip itself (and the other column) stay visible
    expect(screen.getByText('Fallout4.esm')).toBeInTheDocument();
    expect(screen.getByText('Override Name')).toBeInTheDocument();
  });

  it('clicking a collapsed column chip again expands it', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Original Name'));

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('Original Name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.getByText('Original Name')).toBeInTheDocument();
  });

  it('collapsed column header hides the (read-only) label', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('(read-only)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Fallout4.esm'));
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
  });

  it('collapsed state survives a LOAD_RECORD navigation to a different formKey', async () => {
    render(<RecordPanel />);
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
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a field cell is not draggable in view mode', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Original Name'));
    const cell = screen.getByText('Original Name').closest('td')!;
    expect(cell.getAttribute('draggable')).toBe('false');
  });

  it('a field cell becomes draggable with a grab cursor in edit mode', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    const cell = screen.getByDisplayValue('Original Name').closest('td')!;
    expect(cell.getAttribute('draggable')).toBe('true');
    expect(cell.style.cursor).toBe('grab');
  });
});

// ── Drag-drop staging (issue #3) ──────────────────────────────────────────────

describe('RecordPanel — drag-drop stages a pending field change', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('dragging from a read-only source column and dropping on an editable target column stages the value there (copy, not move)', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));

    // Fallout4.esm is immutable — dragging FROM it is allowed (copy source).
    const sourceCell = screen.getByDisplayValue('Original Name').closest('td')!;
    // MyMod.esp is mutable — a valid drop target.
    const targetCell = screen.getByDisplayValue('Override Name').closest('td')!;

    fireEvent.dragStart(sourceCell);
    fireEvent.drop(targetCell);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    );
    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as {
      plugin: string;
      fields: Record<string, unknown>;
    };
    expect(body.plugin).toBe('MyMod.esp');
    expect(body.fields['Name']).toBe('Original Name');
  });

  it('dropping on a read-only (immutable) target column is rejected as a no-op — no PATCH is sent', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));

    // MyMod.esp is mutable — a valid drag source.
    const sourceCell = screen.getByDisplayValue('Override Name').closest('td')!;
    // Fallout4.esm is immutable — must reject the drop.
    const targetCell = screen.getByDisplayValue('Original Name').closest('td')!;

    fireEvent.dragStart(sourceCell);
    fireEvent.drop(targetCell);

    // Let any (incorrect) async staging work run before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH'),
    ).toBe(false);
  });
});

// ── Column header context menu (issue #3) ─────────────────────────────────────

describe('RecordPanel — column header context menu', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', makeFetch());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('right-clicking a plugin column header shows Copy All to Pending, Copy as New Record, and Remove Override', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as New Record' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toBeInTheDocument();
  });

  it('Remove Override is disabled on an immutable plugin column, enabled on a mutable one', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Fallout4.esm'));

    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toHaveAttribute('aria-disabled', 'true');

    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('pressing Escape closes the menu', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Copy All to Pending' })).not.toBeInTheDocument();
  });

  it('clicking outside the menu closes it', async () => {
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();

    fireEvent.click(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Copy All to Pending' })).not.toBeInTheDocument();
  });
});

// ── Remove Override (issue #3) ────────────────────────────────────────────────

function makeFetchWithDelete() {
  return vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/records/delete')) {
      return { ok: true, json: () => Promise.resolve({}) };
    }
    if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(compareResult) };
    if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
    if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve(pluginsResponse) };
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
}

describe('RecordPanel — Remove Override', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clicking Remove Override on a mutable column stages a delete via POST /records/delete', async () => {
    const fetchMock = makeFetchWithDelete();
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('MyMod.esp'));
    fireEvent.contextMenu(screen.getByText('MyMod.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Override' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/records/delete'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes('/records/delete'));
    const body = JSON.parse((call![1] as RequestInit).body as string) as {
      records: { formKey: string; plugin: string }[];
    };
    expect(body.records).toEqual([{ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp' }]);
  });

  it('Remove Override is disabled and inert on an immutable column — no delete call is made', async () => {
    const fetchMock = makeFetchWithDelete();
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Fallout4.esm'));
    fireEvent.contextMenu(screen.getByText('Fallout4.esm').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Override' }));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/records/delete')),
    ).toBe(false);
  });
});

// ── Copy All to Pending (issue #3) ────────────────────────────────────────────

function makeThreePluginFetch() {
  return vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: true, json: () => Promise.resolve({}) };
    if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(threePluginConflictResult) };
    if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
    if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve([
      { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
      { name: 'Mod1.esp', isImmutable: false, loadOrderIndex: 1 },
      { name: 'Mod2.esp', isImmutable: false, loadOrderIndex: 2 },
    ]) };
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
}

describe('RecordPanel — Copy All to Pending', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens a target picker offering mutable plugins other than the source column', async () => {
    vi.stubGlobal('fetch', makeThreePluginFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));

    expect(screen.getByRole('menuitem', { name: 'Mod2.esp' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mod1.esp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Fallout4.esm' })).not.toBeInTheDocument();
  });

  it('selecting a target stages one PATCH with every field from the source column', async () => {
    const fetchMock = makeThreePluginFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    );
    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as {
      plugin: string;
      fields: Record<string, unknown>;
    };
    expect(body.plugin).toBe('Mod2.esp');
    expect(body.fields['Name']).toBe('Bob');
  });
});

// ── Copy as New Record (issue #3) ─────────────────────────────────────────────

describe('RecordPanel — Copy as New Record', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the same target picker as Copy All to Pending', async () => {
    vi.stubGlobal('fetch', makeThreePluginFetch());
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as New Record' }));

    expect(screen.getByRole('menuitem', { name: 'Mod2.esp' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Mod1.esp' })).not.toBeInTheDocument();
  });

  it('selecting a target creates a new record of the source column\'s type, then stages every source field on it', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && /\/plugins\/[^/]+\/records$/.test(String(url))) {
        return { ok: true, json: () => Promise.resolve({ formKey: '000099:Mod2.esp', groupId: 'g1' }) };
      }
      if (init?.method === 'PATCH') return { ok: true, json: () => Promise.resolve({}) };
      if (String(url).includes('/compare')) return { ok: true, json: () => Promise.resolve(threePluginConflictResult) };
      if (String(url).includes('/changes'))  return { ok: true, json: () => Promise.resolve([]) };
      if (String(url).includes('/plugins'))  return { ok: true, json: () => Promise.resolve([
        { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
        { name: 'Mod1.esp', isImmutable: false, loadOrderIndex: 1 },
        { name: 'Mod2.esp', isImmutable: false, loadOrderIndex: 2 },
      ]) };
      return { ok: false, status: 404, statusText: 'Not Found' };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecordPanel />);
    await waitFor(() => screen.getByText('Bob'));
    fireEvent.contextMenu(screen.getByText('Mod1.esp').closest('th')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as New Record' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mod2.esp' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/plugins/Mod2.esp/records'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const createCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'POST' && /\/plugins\/[^/]+\/records$/.test(String(c[0])),
    );
    const createBody = JSON.parse((createCall![1] as RequestInit).body as string) as { recordType: string };
    expect(createBody.recordType).toBe('npc_');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/records/000099%3AMod2.esp'),
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'PATCH',
    );
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string) as {
      plugin: string;
      fields: Record<string, unknown>;
    };
    expect(patchBody.plugin).toBe('Mod2.esp');
    expect(patchBody.fields['Name']).toBe('Bob');
  });
});
