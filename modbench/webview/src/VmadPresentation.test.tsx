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
    .map(m => m.split('.').reduce<unknown>((v, name) => (v as Obj | null)?.[name], element))
    .map(v => String(v ?? ''))
    .join(' / ');

function keysOf(meta: FieldMetadata, values: Record<string, unknown>): string[] {
  const lists = Object.values(values).map(v => (Array.isArray(v) ? v : []));
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

  return diffNode({
    fieldName,
    values,
    winnerColumn: columns[0],
    resolutions: resolved.length === 0 ? undefined : Object.fromEntries(resolved.map(c => [c, {
      state: 'ResolvedValidType' as const, recordType: null, editorId: editorIds[values[c] as string],
    }])),
    children:
      meta.type === 'array' && meta.elementType
        ? each(keysOf(meta, values).map(k =>
          [k, meta.elementType!, (c: string) => elementAt(meta, values[c], k)]))
        : meta.type === 'struct'
          ? each((meta.fields ?? []).map(f => [f.name, f, (c: string) => (values[c] as Obj | null)?.[f.name]]))
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
  const td = screen.getAllByText(field).find(el => el.tagName === 'TD');
  expect(td, `no row named ${field}`).toBeDefined();
  return td as HTMLTableCellElement;
}

const summaryOf = (field: string): string =>
  fieldCell(field).closest('tr')!.querySelectorAll('td')[1]!.textContent;

const expandRow = (field: string) =>
  fireEvent.click(fieldCell(field).closest('tr')!.querySelector('button')!);

async function expandScripts() {
  await waitFor(() => screen.getByText('Scripts'));
  fireEvent.click(screen.getAllByText('▶')[0]!);
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
  (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
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
    const unknownBase: FieldMetadata = {
      ...scriptsMeta,
      elementType: {
        ...scriptsMeta.elementType!,
        fields: scriptsMeta.elementType!.fields!.map(f => (f.name !== 'Properties' ? f : {
          ...f, elementType: { ...propertyMeta, leafTypeName: 'SomethingElse', fields: propertyMeta.fields!.filter(m => !m.isDiscriminator) },
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
    fireEvent.click(screen.getAllByText('▶')[0]!);
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

    const cells = fieldCell('Data').closest('tr')!.querySelectorAll('td');
    expect(cells[1]!.textContent).toBe('3');
    expect(cells[2]!.textContent).toBe('');
  });
});

describe('Add Script is the generic array gesture', () => {
  // The webview contributes no element: a new script's key is empty until the user names it,
  // so it appears first and is then nameable.
  it('posts the array op and no element of its own', async () => {
    currentCompare = oneColumn([script('Guard')]);
    renderPanel();
    await waitFor(() => screen.getByText('Scripts'));

    const cell = screen.getAllByText('[1]')[0]!.closest('td')!;
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
    // Its Field column holds nothing but the disclosure control: the key is still empty.
    expect(added!.querySelectorAll('td')[0]!.textContent).toBe('▶');
    expect(added!.querySelectorAll('td')[1]!.textContent).toBe('()');

    // Nameable: its own `name` cell takes an edit like any other string cell, addressed through
    // the empty key — the only handle the element has until it is named.
    fireEvent.click(added!.querySelector('button')!);
    await waitFor(() => screen.getAllByText('Name'));
    const nameCell = screen.getAllByText('Name')[0]!.closest('tr')!.querySelectorAll('td')[1];
    fireEvent.doubleClick(nameCell!.querySelector('[data-open-trigger]')!);
    const input = nameCell!.querySelector('input')!;
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

    const dataCell = fieldCell('Data').closest('tr')!.querySelectorAll('td')[1];
    fireEvent.doubleClick(dataCell!.querySelector('[data-open-trigger]')!);
    const input = dataCell!.querySelector('input')!;
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

    const cell = fieldCell('Radius').closest('tr')!.querySelectorAll('td')[1];
    fireEvent.click(cell!);
    fireEvent.keyDown(cell!, { key: 'Delete' });

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

    const cell = fieldCell('Properties').closest('tr')!.querySelectorAll('td')[1];
    fireEvent.click(cell!);
    fireEvent.keyDown(cell!, { key: 'Insert' });

    expect(lastEnvelope()).toEqual({
      op: 'add',
      path: [{ kind: 'member', name: 'Scripts' }, { kind: 'key', key: 'Guard' }, { kind: 'member', name: 'Properties' }],
    });
  });
});
