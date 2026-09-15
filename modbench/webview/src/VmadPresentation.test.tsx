import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldDiff, FieldMetadata } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW } from './messages';
import { diffNode, fieldMeta, leafMeta as field, lastPostedEnvelope, panelClient } from './test/fixtures';

// The metadata below is the Fallout 4 schema's own shape, trimmed to the leaves these cases
// name; the keyed arrays and their key members are Fallout4VmadAnnotations.KeyedArrays.

// LeafLabel.For('ScriptProperty', leaf) — the base's own words dropped from head and tail.
const PROPERTY_LEAVES: Record<string, string> = {
  ScriptBoolProperty: 'Bool',
  ScriptFloatProperty: 'Float',
  ScriptIntProperty: 'Int',
  ScriptObjectListProperty: 'Object List',
  ScriptObjectProperty: 'Object',
  ScriptProperty: 'Script Property',
  ScriptStringListProperty: 'String List',
  ScriptStringProperty: 'String',
  ScriptVariableProperty: 'Variable',
};

const objectBindingMeta = (name: string, extra: Partial<FieldMetadata> = {}): FieldMetadata => fieldMeta({
  name, type: 'struct',
  leafTypeName: 'ScriptObjectProperty',
  fields: [field('Object', 'formKey'), field('Alias', 'int')],
  ...extra,
});

// Data is one member whose type the leaf decides: the backend's schema carries a variant per
// leaf, and the field's own shape is the first leaf's.
const dataMeta: FieldMetadata = field('Data', 'bool', {
  variants: {
    ScriptBoolProperty: field('Data', 'bool'),
    ScriptFloatProperty: field('Data', 'float'),
    ScriptIntProperty: field('Data', 'int'),
    ScriptStringProperty: field('Data', 'string'),
    ScriptStringListProperty: field('Data', 'array', { isArray: true, elementType: field('', 'string') }),
  },
});

const propertyMeta = fieldMeta({
  name: '', type: 'struct',
  leafTypeName: 'ScriptProperty',
  fields: [
    field('Name', 'string'),
    field('Flags', 'flags', { enumMembers: [{ value: 'Edited', bitValue: '1', label: null }] }),
    dataMeta,
    field('Object', 'formKey'),
    field('Alias', 'int'),
    field('Objects', 'array', { isArray: true, elementType: objectBindingMeta('') }),
    field('MutagenObjectType', 'enum', {
      displayLabel: 'Kind', isDiscriminator: true,
      enumMembers: Object.entries(PROPERTY_LEAVES).map(([value, label]) => ({ value, bitValue: null, label })),
    }),
  ],
});

const scriptsMeta = fieldMeta({
  name: 'Scripts', type: 'array', isArray: true,
  keyMembers: ['Name'],
  elementType: fieldMeta({
    name: '', type: 'struct',
    leafTypeName: 'ScriptEntry',
    fields: [
      field('Name', 'string'),
      field('Flags', 'enum', { enumMembers: [{ value: 'Local', bitValue: null, label: null }] }),
      field('Properties', 'array', { isArray: true, keyMembers: ['Name'], elementType: propertyMeta }),
    ],
  }),
});

// Fallout4VmadAnnotations keys alias bindings by the dotted `Property.Alias`, where a script is
// keyed by the plain `Name`; the webview receives either as one opaque key string.
const aliasesMeta = fieldMeta({
  name: 'Aliases', type: 'array', isArray: true,
  keyMembers: ['Property.Alias'],
  elementType: fieldMeta({
    name: '', type: 'struct',
    leafTypeName: 'QuestFragmentAlias',
    fields: [objectBindingMeta('Property'), scriptsMeta],
  }),
});

type Obj = Record<string, unknown>;

// Every field/element/property lookup below walks a plain JS structure this file itself built —
// `Reflect.get` on the guarded `object` reads a member without narrowing away from `unknown`.
function propertyOf(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

// Array.isArray's own type guard narrows to `any[]`; this narrows to `unknown[]` instead.
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stringValueAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

// The document's own spelling: the discriminator first, then only the members the leaf carries.
const property = (name: string, concreteType: string, over: Obj = {}): Obj => ({
  MutagenObjectType: concreteType, Name: name, Flags: ['Edited'],
  ...over,
});

const script = (name: string, properties: Obj[] = []): Obj => ({ Name: name, Flags: 'Local', Properties: properties });

const PLUGIN = 'MyMod.esp';

// Driven by the metadata rather than by the values, so a member a column leaves null still has
// its row and its per-column values — the union-aligned tree the backend sends.

// Joined the way the backend joins them; a key member may be dotted, so each one is a path.
const keyTextOf = (keyMembers: string[], element: unknown): string =>
  keyMembers
    .map(m => m.split('.').reduce<unknown>((v, name) => propertyOf(v, name), element))
    // Every key member this file's fixtures use (Name, Property.Alias) is a string or a number.
    .map(v => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
    .join(' / ');

function keysOf(meta: FieldMetadata, values: Record<string, unknown>): string[] {
  const lists = Object.values(values).map(v => (isUnknownArray(v) ? v : []));
  const { keyMembers } = meta;
  if (keyMembers) return [...new Set(lists.flatMap(l => l.map(e => keyTextOf(keyMembers, e))))].sort();
  return Array.from({ length: Math.max(0, ...lists.map(l => l.length)) }, (_, i) => `[${i}]`);
}

function elementAt(meta: FieldMetadata, list: unknown, key: string): unknown {
  if (!Array.isArray(list)) return null;
  const { keyMembers } = meta;
  if (!keyMembers) return list[Number(key.slice(1, -1))] ?? null;
  return list.find(e => keyTextOf(keyMembers, e) === key) ?? null;
}

function buildDiff(
  fieldName: string, meta: FieldMetadata, values: Record<string, unknown>,
  editorIds: Record<string, string>,
): FieldDiff {
  const columns = Object.keys(values);
  const resolved = columns.filter(c => typeof values[c] === 'string' && editorIds[values[c]]);
  const each = (children: [string, FieldMetadata, (column: string) => unknown][]): FieldDiff[] =>
    children.map(([name, childMeta, pick]) => buildDiff(
      name, childMeta, Object.fromEntries(columns.map(c => [c, pick(c) ?? null])), editorIds));
  const { elementType } = meta;

  return diffNode({
    fieldName,
    values,
    winnerColumn: columns[0],
    resolutions: resolved.length === 0 ? undefined : Object.fromEntries(resolved.map(c => [c, {
      state: 'ResolvedValidType' as const, recordType: null, editorId: editorIds[stringValueAt(values, c)],
    }])),
    children:
      meta.type === 'array' && elementType
        ? each(keysOf(meta, values).map(k =>
          [k, elementType, (c: string) => elementAt(meta, values[c], k)]))
        : meta.type === 'struct'
          ? each((meta.fields ?? []).map(f => [f.name, f, (c: string) => propertyOf(values[c], f.name)]))
          : undefined,
  });
}

function compareResult(
  byColumn: Record<string, Obj[]>, editorIds: Record<string, string> = {}, meta: FieldMetadata = scriptsMeta,
) {
  const columns = Object.keys(byColumn);
  return {
    conflictAll: 'NoConflict',
    overrides: columns.map((plugin, i) => ({
      formKey: '000001:MyMod.esp', plugin, origin: 'Data',
      loadOrderIndex: i + 1, isWinner: i === 0, editorId: 'TestNpc',
      fields: [{ metadata: meta, value: byColumn[plugin] }], conflictThis: 'Master',
    })),
    diffs: [buildDiff(meta.name, meta, byColumn, editorIds)],
  };
}

const oneColumn = (scripts: Obj[], editorIds: Record<string, string> = {}, meta: FieldMetadata = scriptsMeta) =>
  compareResult({ [PLUGIN]: scripts }, editorIds, meta);

let currentCompare: unknown = null;

function renderPanel() {
  return render(<RecordPanel client={panelClient(() => currentCompare, {
    plugins: [{ name: PLUGIN, isTracked: true }],
  })} />);
}

function fieldCell(field: string): HTMLTableCellElement {
  const td = screen.getAllByText(field).find((el): el is HTMLTableCellElement => el.tagName === 'TD');
  if (!td) throw new Error(`no row named ${field}`);
  return td;
}

function rowOf(el: Element): HTMLTableRowElement {
  const row = el.closest('tr');
  if (!row) throw new Error('no <tr> ancestor');
  return row;
}

function cellAt(row: Element, index: number): HTMLTableCellElement {
  const cell = row.querySelectorAll('td')[index];
  if (!cell) throw new Error(`no <td> at index ${index} in this row`);
  return cell;
}

function firstChevron(): HTMLElement {
  const chevron = screen.getAllByText('▶')[0];
  if (!chevron) throw new Error('no ▶ chevron to expand');
  return chevron;
}

const summaryOf = (field: string): string => cellAt(rowOf(fieldCell(field)), 1).textContent;

const expandRow = (field: string) => {
  const button = rowOf(fieldCell(field)).querySelector('button');
  if (!button) throw new Error(`no expand button in ${field}'s row`);
  fireEvent.click(button);
};

async function expandScripts() {
  await waitFor(() => screen.getByText('Scripts'));
  fireEvent.click(firstChevron());
}

const lastEnvelope = () => lastPostedEnvelope(vscode.postMessage);

function reloadWith(compare: unknown) {
  currentCompare = compare;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:MyMod.esp' },
  }));
}

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
  vi.mocked(vscode.postMessage).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('a collapsed script reads as xEdit prose', () => {
  it('a script reads under its own name with every property passed through, not counted', async () => {
    currentCompare = oneColumn([script('Guard', [
      property('Awake', 'ScriptBoolProperty', { Data: true }),
      property('Radius', 'ScriptIntProperty', { Data: 10 }),
    ])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard(Awake: Bool = true, Radius: Int = 10)');
  });

  it('a script with no properties reads as its own name and an empty list', async () => {
    currentCompare = oneColumn([script('Bare')]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Bare'));

    expect(summaryOf('Bare')).toBe('Bare()');
  });

  it('a property reads name, kind and value, the kind coming from the schema’s own leaf label', async () => {
    currentCompare = oneColumn([script('Guard', [
      property('Radius', 'ScriptIntProperty', { Data: 10 }),
      property('Rate', 'ScriptFloatProperty', { Data: 2.5 }),
      property('Tag', 'ScriptStringProperty', { Data: 'alpha' }),
    ])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));
    expandRow('Properties');
    await waitFor(() => screen.getByText('Radius'));

    expect(summaryOf('Radius')).toBe('Radius: Int = 10');
    expect(summaryOf('Rate')).toBe('Rate: Float = 2.5');
    expect(summaryOf('Tag')).toBe('Tag: String = alpha');
  });

  it('an object binding reads as the bound record’s own cell text and its alias slot', async () => {
    currentCompare = oneColumn(
      [script('Guard', [property('Owner', 'ScriptObjectListProperty', {
        Objects: [{ Object: '00000014:Fallout4.esm', Alias: -1 }],
      })])],
      { '00000014:Fallout4.esm': 'PlayerRef' },
    );
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));
    expandRow('Properties');
    await waitFor(() => screen.getByText('Owner'));
    expandRow('Owner');
    await waitFor(() => screen.getByText('Objects'));
    expandRow('Objects');
    await waitFor(() => screen.getByText('[0]'));

    expect(summaryOf('[0]')).toBe('PlayerRef [00000014:Fallout4.esm], Alias[None]');
  });

  it('the same binding read as a property of its own takes the property’s shape around it', async () => {
    currentCompare = oneColumn(
      [script('Guard', [property('Owner', 'ScriptObjectProperty', {
        Object: '00000014:Fallout4.esm', Alias: -1,
      })])],
      { '00000014:Fallout4.esm': 'PlayerRef' },
    );
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard'))
      .toBe('Guard(Owner: Object = PlayerRef [00000014:Fallout4.esm], Alias[None])');
  });

  it('a property whose value is a list reads by name and kind alone', async () => {
    // xEdit passes a property's own value through one level only
    // (wbScriptProperties.SetSummaryPassthroughMaxDepth(1)); the elements have their own rows.
    currentCompare = oneColumn([script('Guard', [
      property('Names', 'ScriptStringListProperty', { Data: ['a', 'b'] }),
    ])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard(Names: String List)');
  });

  it('a leaf the table has no reading of its own for reads by its declared base’s', async () => {
    // The rule that keeps fifteen leaves to one entry. ScriptVariableProperty has no entry and no
    // value member; it still reads as a property, because ScriptProperty is what it is.
    currentCompare = oneColumn([script('Guard', [property('V', 'ScriptVariableProperty')])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard(V: Variable)');
  });

  it('an element of a passed-through list whose leaf has no reading at all still occupies its place', async () => {
    // Nothing may vanish from a passthrough: a dropped element would make a script with two
    // properties read exactly like a script with one.
    const { elementType: scriptElementType } = scriptsMeta;
    if (!scriptElementType) throw new Error("scriptsMeta's elementType is missing");
    const { fields: scriptElementFields } = scriptElementType;
    if (!scriptElementFields) throw new Error("scriptsMeta's elementType has no fields");
    const { fields: propertyFields } = propertyMeta;
    if (!propertyFields) throw new Error('propertyMeta has no fields');
    const unknownBase: FieldMetadata = {
      ...scriptsMeta,
      elementType: {
        ...scriptElementType,
        fields: scriptElementFields.map(f => (f.name !== 'Properties' ? f : {
          ...f, elementType: { ...propertyMeta, leafTypeName: 'SomethingElse', fields: propertyFields.filter(m => !m.isDiscriminator) },
        })),
      },
    };
    const unnamed = property('Radius', 'ScriptIntProperty', { Data: 10 });
    delete unnamed.MutagenObjectType;
    currentCompare = oneColumn([script('Guard', [unnamed, { ...unnamed, Name: 'Speed' }])], {}, unknownBase);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard({…}, {…})');
  });

  it('the concrete base is a leaf like any other and reads with no value', async () => {
    currentCompare = oneColumn([script('Guard', [property('Nothing', 'ScriptProperty')])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard(Nothing: Script Property)');
  });
});

describe('the alias slot of an object binding', () => {
  const withAlias = (alias: number) => oneColumn(
    [script('Guard', [property('Owner', 'ScriptObjectProperty', {
      Object: '00000014:Fallout4.esm', Alias: alias,
    })])],
    { '00000014:Fallout4.esm': 'PlayerRef' });

  it.each([[-1, 'None'], [-2, 'Player'], [3, '3']])(
    'alias %i reads as %s', async (alias, expected) => {
      currentCompare = withAlias(alias);
      renderPanel();
      await expandScripts();
      await waitFor(() => screen.getByText('Guard'));

      expect(summaryOf('Guard'))
        .toBe(`Guard(Owner: Object = PlayerRef [00000014:Fallout4.esm], Alias[${expected}])`);
    });
});

describe('a row of a keyed array is identified by its key', () => {
  it('expanding one script and then losing an earlier sibling leaves that script expanded', async () => {
    currentCompare = oneColumn([
      script('Ambush', [property('Radius', 'ScriptIntProperty', { Data: 10 })]),
      script('Guard', [property('Radius', 'ScriptIntProperty', { Data: 20 })]),
    ]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));
    expandRow('Properties');
    await waitFor(() => screen.getByText('Radius'));

    // The compare the panel re-reads after a remove of the earlier sibling. Guard now sits where
    // Ambush did: identity by key survives that, identity by position does not.
    reloadWith(oneColumn([script('Guard', [property('Radius', 'ScriptIntProperty', { Data: 20 })])]));
    await waitFor(() => expect(screen.queryByText('Ambush')).not.toBeInTheDocument());

    expect(screen.getByText('Properties')).toBeInTheDocument();
    expect(summaryOf('Radius')).toBe('Radius: Int = 20');
  });

  it('a dotted key identifies its row the same way a plain one does', async () => {
    const alias = (index: number, scriptName: string): Obj =>
      ({ Property: { Alias: index }, Scripts: [script(scriptName)] });
    currentCompare = oneColumn([alias(0, 'First'), alias(1, 'Second')], {}, aliasesMeta);
    renderPanel();
    await waitFor(() => screen.getByText('Aliases'));
    fireEvent.click(firstChevron());
    await waitFor(() => screen.getByText('1'));
    expandRow('1');
    await waitFor(() => screen.getByText('Scripts'));
    expandRow('Scripts');
    await waitFor(() => screen.getByText('Second'));

    reloadWith(oneColumn([alias(1, 'Second')], {}, aliasesMeta));
    await waitFor(() => expect(screen.queryByText('0')).not.toBeInTheDocument());

    expect(summaryOf('Second')).toBe('Second()');
  });

  it('two scripts sharing a property name keep their own rows apart', async () => {
    currentCompare = oneColumn([
      script('Ambush', [property('Radius', 'ScriptIntProperty', { Data: 10 })]),
      script('Guard', [property('Radius', 'ScriptIntProperty', { Data: 20 })]),
    ]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Ambush'));

    expect(summaryOf('Ambush')).toBe('Ambush(Radius: Int = 10)');
    expect(summaryOf('Guard')).toBe('Guard(Radius: Int = 20)');

    // Expanding one leaves the other collapsed — a row is its own key's, not its position's.
    expandRow('Ambush');
    await waitFor(() => screen.getAllByText('Properties'));
    expect(screen.getAllByText('Properties')).toHaveLength(1);
    expect(summaryOf('Guard')).toBe('Guard(Radius: Int = 20)');
  });
});

// Data's shape varies by leaf, and a leaf the variants do not name has no Data at all: that
// column's cell is nothing, not the base shape's default.
describe('a member the column\'s own leaf does not declare', () => {
  it('renders nothing in that column, beside the value the other column\'s leaf holds', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [script('Guard', [property('Owner', 'ScriptIntProperty', { Data: 3 })])],
      'Other.esp': [script('Guard', [property('Owner', 'ScriptObjectProperty', { Object: '00000014:Fallout4.esm', Alias: -1 })])],
    });
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));
    expandRow('Properties');
    await waitFor(() => screen.getByText('Owner'));
    expandRow('Owner');
    await waitFor(() => screen.getByText('Data'));

    const dataRow = rowOf(fieldCell('Data'));
    expect(cellAt(dataRow, 1).textContent).toBe('3');
    expect(cellAt(dataRow, 2).textContent).toBe('');
  });
});

describe('Add Script is the generic array gesture', () => {
  // The webview contributes no element: a new script's key is empty until the user names it,
  // so it appears first and is then nameable.
  it('posts the array op and no element of its own', async () => {
    currentCompare = oneColumn([script('Guard')]);
    renderPanel();
    await waitFor(() => screen.getByText('Scripts'));

    const marker = screen.getAllByText('[1]')[0];
    if (!marker) throw new Error("no '[1]' key marker rendered");
    const cell = marker.closest('td');
    if (!cell) throw new Error("no <td> ancestor for the '[1]' key marker");
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEnvelope()).toEqual({ op: 'add', path: [{ kind: 'member', name: 'Scripts' }] });
  });

  it('the added script is a row of its own in that plugin’s column, and is nameable there', async () => {
    currentCompare = oneColumn([script('Guard')]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    // The new script's key is empty until the user names it, so it sorts first.
    reloadWith(oneColumn([script(''), script('Guard')]));
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(3));

    // First of the two script rows, since the empty key sorts before every named one.
    const added = document.querySelectorAll('tbody tr')[1];
    if (!added) throw new Error('no second script row after the reload');
    // Its Field column holds nothing but the disclosure control: the key is still empty.
    expect(cellAt(added, 0).textContent).toBe('▶');
    expect(cellAt(added, 1).textContent).toBe('()');

    // Nameable: its own `name` cell takes an edit like any other string cell, addressed through
    // the empty key — the only handle the element has until it is named.
    const expandButton = added.querySelector('button');
    if (!expandButton) throw new Error("no expand button on the added script's row");
    fireEvent.click(expandButton);
    await waitFor(() => screen.getAllByText('Name'));
    const nameLabel = screen.getAllByText('Name')[0];
    if (!nameLabel) throw new Error("no 'Name' row rendered");
    const nameCell = cellAt(rowOf(nameLabel), 1);
    const openTrigger = nameCell.querySelector('[data-open-trigger]');
    if (!openTrigger) throw new Error("no open trigger in Name's value cell");
    fireEvent.doubleClick(openTrigger);
    const input = nameCell.querySelector('input');
    if (!input) throw new Error("no input in Name's value cell");
    fireEvent.change(input, { target: { value: 'Ambush' } });
    fireEvent.blur(input);

    expect(lastEnvelope()).toEqual({
      op: 'set',
      path: [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: '' }, { kind: 'member', name: 'Name' }],
      value: 'Ambush',
    });
  });

  // A property lives two keyed hops down; every hop travels, each key as the diff node states it.
  it('an edit under a nested keyed array carries the key hop at each level', async () => {
    currentCompare = oneColumn([script('Guard', [property('Radius', 'ScriptIntProperty', { Data: 10 })])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));
    expandRow('Properties');
    await waitFor(() => screen.getByText('Radius'));
    expandRow('Radius');
    await waitFor(() => screen.getByText('Data'));

    const dataCell = cellAt(rowOf(fieldCell('Data')), 1);
    const openTrigger = dataCell.querySelector('[data-open-trigger]');
    if (!openTrigger) throw new Error("no open trigger in Data's value cell");
    fireEvent.doubleClick(openTrigger);
    const input = dataCell.querySelector('input');
    if (!input) throw new Error("no input in Data's value cell");
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.blur(input);

    expect(lastEnvelope()).toEqual({
      op: 'set',
      path: [
        { kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' },
        { kind: 'member', name: 'Properties' }, { kind: 'key', key: 'Radius' },
        { kind: 'member', name: 'Data' },
      ],
      value: 25,
    });
  });

  it('Delete on a property under a keyed script posts remove through both key hops', async () => {
    currentCompare = oneColumn([script('Guard', [property('Radius', 'ScriptIntProperty', { Data: 10 })])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));
    expandRow('Properties');
    await waitFor(() => screen.getByText('Radius'));

    const cell = cellAt(rowOf(fieldCell('Radius')), 1);
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Delete' });

    expect(lastEnvelope()).toEqual({
      op: 'remove',
      path: [
        { kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' },
        { kind: 'member', name: 'Properties' }, { kind: 'key', key: 'Radius' },
      ],
    });
  });

  it('Insert on a property list nested under a keyed script posts add through the key hop', async () => {
    currentCompare = oneColumn([script('Guard', [property('Radius', 'ScriptIntProperty', { Data: 10 })])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('Properties'));

    const cell = cellAt(rowOf(fieldCell('Properties')), 1);
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Insert' });

    expect(lastEnvelope()).toEqual({
      op: 'add',
      path: [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }, { kind: 'member', name: 'Properties' }],
    });
  });
});
