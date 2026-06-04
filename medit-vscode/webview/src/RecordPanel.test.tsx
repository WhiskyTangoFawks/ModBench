import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { ScalarCell, FormKeyCell, RecordPanel } from './RecordPanel';
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
    expect((screen.getByDisplayValue('Dogmeat') as HTMLInputElement).type).toBe('text');
  });

  it('renders a number input for int type', () => {
    render(<ScalarCell value={5} meta={intMeta} editMode={true} onCommit={vi.fn()} />);
    expect((screen.getByDisplayValue('5') as HTMLInputElement).type).toBe('number');
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
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
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
    },
  ],
};

const pluginsResponse = [
  { name: 'Fallout4.esm', isImmutable: true,  loadOrderIndex: 0 },
  { name: 'MyMod.esp',    isImmutable: false, loadOrderIndex: 1 },
];

function makeFetch() {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/compare')) return { ok: true, json: async () => compareResult };
    if (String(url).includes('/changes'))  return { ok: true, json: async () => [] };
    if (String(url).includes('/plugins'))  return { ok: true, json: async () => pluginsResponse };
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
    },
  ],
};

describe('RecordPanel — postMessage wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('mEditFormKey', '000001:Fallout4.esm');
    vi.stubGlobal('mEditBackendPort', 15172);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/compare')) return { ok: true, json: async () => fkCompareResult };
      if (String(url).includes('/changes'))  return { ok: true, json: async () => [] };
      if (String(url).includes('/plugins'))  return { ok: true, json: async () => [{ name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 }] };
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

    await act(async () => {
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
