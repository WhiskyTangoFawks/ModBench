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
      pendingFields: {}, conflictThis: 'ConflictLoses' },
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
