import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));
const pickFormKey = vi.fn<(seed: string, validTypes: string[]) => Promise<string | null>>().mockResolvedValue(null);
vi.mock('./nativeBridge', async importOriginal => ({
  ...await importOriginal<typeof import('./nativeBridge')>(),
  pickFormKey: (seed: string, validTypes: string[]) => pickFormKey(seed, validTypes),
}));

import { RecordPanel } from './RecordPanel';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from '../../src/wire/messages';
import { columnKey } from '../../src/wire/columnKey';
import type { CompareResult, FieldDiff, FieldMetadata, FormKeyResolution } from './types';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, lastPostedEnvelope, lastToldCell, member, panelClient,
  parseJsonRecord, required, type FixturePlugin,
} from './test/fixtures';

const FORM_KEY = '000001:Fallout4.esm';
const MASTER = 'Fallout4.esm';
const MOD = 'MyMod.esp';
const MASTER_AND_EDITABLE_MOD: FixturePlugin[] = [
  { name: MASTER, isImmutable: true },
  { name: MOD, isTracked: true },
];

const leaf = (values: Record<string, unknown>, over: Partial<FieldDiff> = {}) =>
  diffNode({ values, winnerColumn: MOD, cellStates: {}, ...over, fieldName: over.fieldName ?? 'Name' });

function recordOf(
  fields: { meta: FieldMetadata; master?: unknown; mod?: unknown; checkErrors?: [string | undefined, string | undefined] }[],
  diffs: FieldDiff[],
  columns: { plugin: string; origin?: string }[] = [{ plugin: MASTER }, { plugin: MOD }],
): CompareResult {
  return compareResultFixture({
    conflictAll: 'NoConflict',
    overrides: columns.map(({ plugin, origin }, column) => compareOverride({
      formKey: FORM_KEY, plugin, origin: origin ?? 'Data', isWinner: column === columns.length - 1, editorId: 'TestNPC',
      fields: fields.map(f => ({
        metadata: f.meta, value: column === 0 ? f.master : f.mod, checkError: f.checkErrors?.[column],
      })),
    })),
    diffs,
  });
}

function renderPanel(compare: CompareResult, plugins: FixturePlugin[] = MASTER_AND_EDITABLE_MOD) {
  return render(<RecordPanel client={panelClient(() => compare, { plugins })} />);
}

const stringMeta = fieldMeta({ name: 'Name', type: 'string' });
const intMeta = fieldMeta({ name: 'Level', type: 'int' });

const rowOf = (label: string) => required(screen.getByText(label).closest('tr'), `the ${label} row`);
const cellsOf = (label: string) => Array.from(rowOf(label).querySelectorAll('td'));
const cellAt = (label: string, index: number) => required(cellsOf(label)[index], `the ${label} row's cell ${index}`);
const contextOf = (cell: Element) =>
  parseJsonRecord(required(cell.getAttribute('data-vscode-context'), "the cell's data-vscode-context attribute"));
const toggleOf = (label: string) => required(cellAt(label, 0).querySelector('button'), `the ${label} row's expand button`);

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', FORM_KEY);
  vi.mocked(vscode.postMessage).mockClear();
  pickFormKey.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('RecordPanel — a scalar row', () => {
  const scalar = recordOf(
    [{ meta: intMeta, master: 5, mod: 5 }],
    [leaf({ [MASTER]: 5, [MOD]: 5 }, { fieldName: 'Level' })]);

  it('offers no expand toggle when the field has no children', async () => {
    renderPanel(scalar);
    await screen.findByText('Level');
    expect(within(rowOf('Level')).queryByRole('button', { name: /[▶▼]/ })).not.toBeInTheDocument();
  });

  it('opens no editor from a click, a second click or a double click in a read-only column', async () => {
    renderPanel(scalar);
    await screen.findByText('Level');
    const cell = cellAt('Level', 1);
    fireEvent.click(cell);
    fireEvent.click(cell);
    fireEvent.doubleClick(cell);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows no grab cursor at rest on a leaf cell', async () => {
    renderPanel(scalar);
    await screen.findByText('Level');
    expect(cellAt('Level', 1).style.cursor).not.toBe('grab');
  });
});

describe('RecordPanel — a row that has children', () => {
  const structMeta = fieldMeta({ name: 'Bounds', type: 'struct', fields: [fieldMeta({ name: 'X', type: 'int' })] });
  const withChild = recordOf(
    [{ meta: structMeta, master: { X: 1 }, mod: { X: 2 } }],
    [leaf({ [MASTER]: { X: 1 }, [MOD]: { X: 2 } }, {
      fieldName: 'Bounds', children: [leaf({ [MASTER]: 1, [MOD]: 2 }, { fieldName: 'X' })],
    })]);

  it('a double click on its label collapses it and a click on its arrow expands it again', async () => {
    renderPanel(withChild);
    await screen.findByText('X');
    fireEvent.doubleClick(cellAt('Bounds', 0));
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    expect(within(rowOf('Bounds')).getByText('▶')).toBeInTheDocument();
    fireEvent.click(toggleOf('Bounds'));
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(within(rowOf('Bounds')).getByText('▼')).toBeInTheDocument();
  });

  it('a double click on the label of a row with no children does nothing', async () => {
    renderPanel(recordOf([{ meta: stringMeta, master: 'a', mod: 'a' }], [leaf({ [MASTER]: 'a', [MOD]: 'a' })]));
    await screen.findByText('Name');
    expect(() => fireEvent.doubleClick(cellAt('Name', 0))).not.toThrow();
  });
});

describe('RecordPanel — the focused cell', () => {
  const two = recordOf(
    [{ meta: stringMeta, master: 'disk-value', mod: 'disk-value' }],
    [leaf({ [MASTER]: 'disk-value', [MOD]: 'disk-value' })]);

  async function focusModCell() {
    renderPanel(two);
    await screen.findByText('Name');
    fireEvent.click(cellAt('Name', 2));
  }

  it('reports its row and column to the host and carries real DOM focus, tabbable', async () => {
    await focusModCell();
    expect(cellAt('Name', 2)).toHaveAttribute('tabindex', '0');
    expect(cellAt('Name', 2)).toHaveFocus();
    expect(cellAt('Name', 1)).not.toHaveFocus();
    expect(lastToldCell(vscode.postMessage)).toMatchObject({ plugin: MOD });
  });

  it('highlights the row holding it, and the cell itself apart from the rest of its row', async () => {
    await focusModCell();
    expect(rowOf('Name').style.boxShadow).toContain('var(--vscode-focusBorder');
    expect(cellAt('Name', 2).style.boxShadow).toContain('var(--vscode-focusBorder');
    expect(cellAt('Name', 2).style.boxShadow).not.toBe(rowOf('Name').style.boxShadow);
    expect(cellAt('Name', 1).style.boxShadow).toBe('');
  });

  it('highlights no row before any cell is focused', async () => {
    renderPanel(two);
    await screen.findByText('Name');
    expect(rowOf('Name').style.boxShadow).toBe('');
    expect(document.body).toHaveFocus();
  });

  it('focuses one of two same-filename, different-origin columns and not the other', async () => {
    const a = columnKey({ name: 'Shared.esp', origin: 'ModA' });
    const b = columnKey({ name: 'Shared.esp', origin: 'ModB' });
    renderPanel(
      recordOf([{ meta: stringMeta, master: 'disk-value', mod: 'disk-value' }], [leaf({ [a]: 'disk-value', [b]: 'disk-value' })],
        [{ plugin: 'Shared.esp', origin: 'ModA' }, { plugin: 'Shared.esp', origin: 'ModB' }]),
      [{ name: 'Shared.esp', origin: 'ModA' }, { name: 'Shared.esp', origin: 'ModB' }]);
    await screen.findByText('Name');
    fireEvent.click(cellAt('Name', 1));
    expect(cellAt('Name', 1)).toHaveFocus();
    expect(cellAt('Name', 2)).not.toHaveFocus();
  });
});

describe('RecordPanel — a reference leaf under a field with a dangling sibling', () => {
  const referenceMeta = fieldMeta({ name: '', type: 'formKey' });
  const validType: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'kywd', editorId: 'SomeKeyword' };
  const wrongType: FormKeyResolution = { state: 'ResolvedWrongType', recordType: 'npc_', editorId: 'SomeNpc' };
  const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

  async function renderLeaf(kind: 'array-element' | 'struct-child', resolution: FormKeyResolution, value: string) {
    const isArray = kind === 'array-element';
    const parentMeta = isArray
      ? fieldMeta({ name: 'Keywords', type: 'array', isArray: true, elementType: referenceMeta })
      : fieldMeta({ name: 'LinkedRef', type: 'struct', fields: [fieldMeta({ name: 'Reference', type: 'formKey' })] });
    const childName = isArray ? '[0]' : 'Reference';
    const child = leaf({ [MASTER]: value }, { fieldName: childName, resolutions: { [MASTER]: resolution } });
    renderPanel(recordOf(
      [{ meta: parentMeta, master: isArray ? [value] : { Reference: value }, mod: undefined,
        checkErrors: ['aggregate: one sibling is dangling', undefined] }],
      [leaf({ [MASTER]: isArray ? [value] : { Reference: value } }, { fieldName: parentMeta.name, children: [child] })]));
    await screen.findByText(childName);
  }

  it.each([
    ['an array-element', 'array-element', validType, '000019:Fallout4.esm', 'SomeKeyword [000019:Fallout4.esm]'],
    ['an array-element wrong-type', 'array-element', wrongType, '00001A:Fallout4.esm', 'SomeNpc [00001A:Fallout4.esm]'],
    ['a struct-child', 'struct-child', validType, '000019:Fallout4.esm', 'SomeKeyword [000019:Fallout4.esm]'],
    ['a struct-child wrong-type', 'struct-child', wrongType, '00001A:Fallout4.esm', 'SomeNpc [00001A:Fallout4.esm]'],
  ] as const)('%s that resolves offers go to record despite the parent field checkError', async (_what, kind, resolution, value, label) => {
    await renderLeaf(kind, resolution, value);
    const menu = contextOf(required(screen.getByText(label).closest('td'), 'the reference cell'));
    expect(menu.webviewSection).toEqual(expect.stringContaining('reference'));
    expect(menu.referenceTarget).toBe(value);
  });

  it.each(['array-element', 'struct-child'] as const)('%s that is unresolved offers no go to record', async (kind) => {
    await renderLeaf(kind, unresolved, 'FFFFFF:Dangling.esm');
    const menu = contextOf(required(screen.getByText('FFFFFF:Dangling.esm').closest('td'), 'the reference cell'));
    expect(menu.webviewSection).not.toEqual(expect.stringContaining('reference'));
  });
});

describe('RecordPanel — the check error is the diff node\'s own, per column', () => {
  const locationMeta = fieldMeta({
    name: 'Location', type: 'struct',
    fields: [fieldMeta({ name: 'Reference', type: 'formKey', validFormKeyTypes: ['REFR'] })],
  });
  const decoys: [string, string] = ['decoy: the root field\'s own error', 'decoy: the root field\'s own error'];
  const dangling = 'Location: its reference is dangling';

  it('shows the warning from the row\'s own diff node, not from the field in the column', async () => {
    renderPanel(recordOf(
      [{ meta: locationMeta, master: {}, mod: {}, checkErrors: decoys }],
      [leaf({ [MASTER]: {}, [MOD]: {} }, { fieldName: 'Location', checkErrors: { [MOD]: dangling } })]));
    await screen.findByText('Location');
    expect(within(cellAt('Location', 2)).getByTitle(dangling)).toBeInTheDocument();
    expect(within(cellAt('Location', 1)).queryByTitle(dangling)).not.toBeInTheDocument();
    expect(screen.queryByTitle(decoys[0])).not.toBeInTheDocument();
  });

  it('shows a struct member the error its own node carries, and none when its node carries none', async () => {
    const error = 'Reference: [FFFFFF:Dangling.esm] <Error: Could not be resolved>';
    renderPanel(recordOf(
      [{ meta: locationMeta, master: { Reference: 'FFFFFF:Dangling.esm' }, mod: { Reference: '000019:Fallout4.esm' }, checkErrors: decoys }],
      [leaf({ [MASTER]: {}, [MOD]: {} }, {
        fieldName: 'Location',
        children: [leaf({ [MASTER]: 'FFFFFF:Dangling.esm', [MOD]: '000019:Fallout4.esm' }, {
          fieldName: 'Reference', checkErrors: { [MASTER]: error },
        })],
      })]));
    await screen.findByText('Reference');
    expect(within(cellAt('Reference', 1)).getByTitle(error)).toBeInTheDocument();
    expect(within(cellAt('Reference', 2)).queryByText('⚠')).not.toBeInTheDocument();
  });

  it('shows an array element its own error, so an element hop does not suppress it', async () => {
    const keywords = fieldMeta({ name: 'Keywords', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'formKey' }) });
    const error = '[FFFFFF:Dangling.esm] <Error: Could not be resolved>';
    renderPanel(recordOf(
      [{ meta: keywords, master: ['FFFFFF:Dangling.esm'], mod: undefined, checkErrors: decoys }],
      [leaf({ [MASTER]: ['FFFFFF:Dangling.esm'] }, {
        fieldName: 'Keywords',
        children: [leaf({ [MASTER]: 'FFFFFF:Dangling.esm' }, { fieldName: '[0]', checkErrors: { [MASTER]: error } })],
      })]));
    await screen.findByText('[0]');
    expect(screen.getByTitle(error)).toBeInTheDocument();
  });
});

describe('RecordPanel — a reference cell', () => {
  const raceMeta = fieldMeta({ name: 'Race', type: 'formKey', validFormKeyTypes: ['race'] });
  const reference = recordOf(
    [{ meta: raceMeta, master: '000019:Fallout4.esm', mod: '000019:Fallout4.esm' }],
    [leaf({ [MASTER]: '000019:Fallout4.esm', [MOD]: '000019:Fallout4.esm' }, { fieldName: 'Race' })]);

  async function clickTwice(column: number) {
    renderPanel(reference);
    await screen.findByText('Race');
    const link = () => within(cellAt('Race', column)).getByText('000019:Fallout4.esm');
    fireEvent.click(link());
    fireEvent.click(link());
  }

  it('in a read-only column does not open the picker', async () => {
    await clickTwice(1);
    expect(pickFormKey).not.toHaveBeenCalled();
  });

  it('in an editable, focused column opens the picker with the field\'s valid types', async () => {
    await clickTwice(2);
    expect(pickFormKey).toHaveBeenCalledWith('000019:Fallout4.esm', ['race']);
  });

  it('writes the picked FormKey, at the field\'s path, to the column\'s plugin copy', async () => {
    pickFormKey.mockResolvedValueOnce('00001A:Fallout4.esm');
    await clickTwice(2);
    await waitFor(() => expect(lastPostedEnvelope(vi.mocked(vscode.postMessage)))
      .toEqual({ op: 'set', path: [member('Race')], value: '00001A:Fallout4.esm' }));
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ plugin: MOD }));
  });
});

describe('RecordPanel — a string cell\'s right-click menu, the extended editor\'s only trigger', () => {
  const strings = recordOf(
    [{ meta: stringMeta, master: 'disk-value', mod: 'disk-value' }],
    [leaf({ [MASTER]: 'disk-value', [MOD]: 'disk-value' })]);

  it('carries a stringValue context with readOnly false, the value and the record\'s own member as its path, in an editable column', async () => {
    renderPanel(strings);
    await screen.findByText('Name');
    expect(contextOf(cellAt('Name', 2))).toEqual({
      webviewSection: 'cell editableCell stringValue',
      holdsValue: true,
      copyText: 'disk-value',
      formKey: FORM_KEY,
      plugin: MOD,
      origin: 'Data',
      recordLabel: `TestNPC [${FORM_KEY}]`,
      fieldName: 'Name',
      value: 'disk-value',
      readOnly: false,
      path: [member('Name')],
      preventDefaultContextMenuItems: true,
    });
  });

  it('carries the context with readOnly true in a read-only column', async () => {
    renderPanel(strings);
    await screen.findByText('Name');
    const context = contextOf(cellAt('Name', 1));
    expect(context.webviewSection).toBe('cell stringValue');
    expect(context.readOnly).toBe(true);
  });

  it('carries a nested cell\'s whole wire path, so its save does not land on the root', async () => {
    const struct = fieldMeta({ name: 'Struct', type: 'struct', fields: [fieldMeta({ name: 'Sub', type: 'string' })] });
    renderPanel(recordOf(
      [{ meta: struct, master: { Sub: 'disk-value' }, mod: { Sub: 'disk-value' } }],
      [leaf({ [MASTER]: {}, [MOD]: {} }, {
        fieldName: 'Struct', children: [leaf({ [MASTER]: 'disk-value', [MOD]: 'disk-value' }, { fieldName: 'Sub' })],
      })]));
    await screen.findByText('Sub');
    const context = contextOf(cellAt('Sub', 2));
    expect(context.path).toEqual([member('Struct'), member('Sub')]);
    expect(context.fieldName).toBe('Sub');
  });

  it('opens the inline editor in place on a double click, never a tab', async () => {
    renderPanel(strings);
    await screen.findByText('Name');
    fireEvent.doubleClick(within(cellAt('Name', 2)).getByText('disk-value'));
    expect(screen.getByDisplayValue('disk-value')).toBeInTheDocument();
    expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: WEBVIEW_TO_EXTENSION.OPEN_IN_PLACE }));
  });
});

describe('RecordPanel — a plain cell\'s right-click menu', () => {
  it('suppresses VS Code\'s own Cut, Copy and Paste items and carries the text copy value copies', async () => {
    renderPanel(recordOf([{ meta: intMeta, master: 7, mod: 7 }], [leaf({ [MASTER]: 7, [MOD]: 7 }, { fieldName: 'Level' })]));
    await screen.findByText('Level');
    expect(contextOf(cellAt('Level', 1))).toEqual({ webviewSection: 'cell', copyText: '7', preventDefaultContextMenuItems: true });
  });

  it('carries the label an enum cell reads, not the class name behind it', async () => {
    const kind = fieldMeta({
      name: 'MutagenObjectType', type: 'enum', displayLabel: 'Kind',
      enumMembers: [{ value: 'QuestReferenceAlias', label: 'Reference' }],
    });
    renderPanel(recordOf(
      [{ meta: kind, master: 'QuestReferenceAlias', mod: 'QuestReferenceAlias' }],
      [leaf({ [MASTER]: 'QuestReferenceAlias', [MOD]: 'QuestReferenceAlias' }, { fieldName: 'MutagenObjectType' })]));
    await screen.findByText('Kind');
    expect(screen.queryByText('MutagenObjectType')).not.toBeInTheDocument();
    expect(contextOf(cellAt('Kind', 1)).copyText).toBe('Reference');
  });
});

describe('RecordPanel — an array\'s right-click context carries the path of the array or element itself', () => {
  const items = fieldMeta({ name: 'Items', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }) });
  const itemsDiff = () => leaf({ [MASTER]: [1, 2], [MOD]: [1, 2] }, {
    fieldName: 'Items',
    children: [
      leaf({ [MASTER]: 1, [MOD]: 1 }, { fieldName: '[0]', indexes: { [MASTER]: 0, [MOD]: 0 } }),
      leaf({ [MASTER]: 2, [MOD]: 2 }, { fieldName: '[1]', indexes: { [MASTER]: 1, [MOD]: 1 } }),
    ],
  });

  it('a top-level array carries the one member hop of its own field', async () => {
    renderPanel(recordOf([{ meta: items, master: [1, 2], mod: [1, 2] }], [itemsDiff()]));
    await screen.findByText('[1]');
    fireEvent.click(toggleOf('Items'));
    const context = contextOf(cellAt('Items', 2));
    expect(context.webviewSection).toBe('cell arrayParent editableCell');
    expect(context.path).toEqual([member('Items')]);
    expect(context.index).toBeUndefined();
    expect(context.fieldName).toBeUndefined();
  });

  it('a nested array carries its whole path from the record\'s member', async () => {
    const container = fieldMeta({ name: 'Container', type: 'struct', fields: [items] });
    renderPanel(recordOf(
      [{ meta: container, master: { Items: [1, 2] }, mod: { Items: [1, 2] } }],
      [leaf({ [MASTER]: {}, [MOD]: {} }, { fieldName: 'Container', children: [itemsDiff()] })]));
    await screen.findByText('[1]');
    fireEvent.click(toggleOf('Items'));
    expect(contextOf(cellAt('Items', 2)).path).toEqual([member('Container'), member('Items')]);
  });

  it('a top-level array element carries a one-hop index path under its array', async () => {
    renderPanel(recordOf([{ meta: items, master: [1, 2], mod: [1, 2] }], [itemsDiff()]));
    await screen.findByText('[1]');
    const context = contextOf(cellAt('[1]', 2));
    expect(context.webviewSection).toBe('cell arrayElement editableCell');
    expect(context.path).toEqual([member('Items'), { kind: 'index', index: 1 }]);
    expect(context.index).toBeUndefined();
  });

  it('a nested array element carries every hop of its own path, not only the trailing index', async () => {
    const container = fieldMeta({ name: 'Container', type: 'struct', fields: [items] });
    renderPanel(recordOf(
      [{ meta: container, master: { Items: [1, 2] }, mod: { Items: [1, 2] } }],
      [leaf({ [MASTER]: {}, [MOD]: {} }, { fieldName: 'Container', children: [itemsDiff()] })]));
    await screen.findByText('[0]');
    expect(contextOf(cellAt('[0]', 2)).path).toEqual([member('Container'), member('Items'), { kind: 'index', index: 0 }]);
  });
});

describe('RecordPanel — a collapsed container row, per column', () => {
  const location = fieldMeta({
    name: 'Location', type: 'struct', allowsNull: true, fields: [fieldMeta({ name: 'aliasId', type: 'int' })],
  });
  const items = fieldMeta({ name: 'Items', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'int' }) });
  const withChild = (fieldName: string, values: Record<string, unknown>) =>
    leaf(values, { fieldName, children: [leaf({ [MASTER]: 1, [MOD]: 1 }, { fieldName: 'child' })] });

  async function collapsed(meta: FieldMetadata, master: unknown, mod: unknown, owner?: FieldMetadata) {
    const node = withChild(meta.name, { [MASTER]: master, [MOD]: mod });
    const ownerValue = (value: unknown) => ({ [meta.name]: value });
    renderPanel(owner
      ? recordOf([{ meta: owner, master: ownerValue(master), mod: undefined }],
        [leaf({ [MASTER]: ownerValue(master) }, { fieldName: owner.name, children: [node] })])
      : recordOf([{ meta, master, mod }], [node]));
    await screen.findByText(meta.name);
    fireEvent.click(toggleOf(meta.name));
  }

  it('shows the placeholder only in the column that has a nullable struct', async () => {
    await collapsed(location, { aliasId: 5 }, null);
    expect(cellAt('Location', 1).textContent).toBe('{…}');
    expect(cellAt('Location', 2).textContent).toBe('');
  });

  it('shows the placeholder in every column for a non-nullable struct one column omits, the omitting column holding its default', async () => {
    await collapsed(fieldMeta({ ...location, allowsNull: false }), { aliasId: 5 }, null);
    expect(cellAt('Location', 1).textContent).toBe('{…}');
    expect(cellAt('Location', 2).textContent).toBe('{…}');
  });

  it('shows the placeholder in every column when both plugins have the struct', async () => {
    await collapsed(location, { aliasId: 5 }, { aliasId: 7 });
    expect(cellAt('Location', 1).textContent).toBe('{…}');
    expect(cellAt('Location', 2).textContent).toBe('{…}');
  });

  it('shows the element count in every column whose owner is there, an absent array as [0]', async () => {
    await collapsed(items, [1, 2, 3], null);
    expect(cellAt('Items', 1).textContent).toBe('[3]');
    expect(cellAt('Items', 2).textContent).toBe('[0]');
  });

  it('shows nothing for an array whose owner the column does not carry', async () => {
    const owner = fieldMeta({ name: 'Owner', type: 'struct', allowsNull: true, fields: [items] });
    await collapsed(items, [1, 2, 3], null, owner);
    expect(cellAt('Items', 1).textContent).toBe('[3]');
    expect(cellAt('Items', 2).textContent).toBe('');
  });

  it('keeps the placeholder in every column for a container no plugin carries a value for', async () => {
    await collapsed(location, undefined, undefined);
    expect(cellAt('Location', 1).textContent).toBe('{…}');
    expect(cellAt('Location', 2).textContent).toBe('{…}');
  });
});
