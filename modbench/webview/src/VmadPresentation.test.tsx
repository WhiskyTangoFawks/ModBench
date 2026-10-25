import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { collapsedReading } from './presentation';
import type { CompareResult, FieldDiff, FieldMetadata } from './types';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW } from '../../src/wire/messages';
import {
  compareResultFixture, fieldCompared, fieldMeta, lastPostedEnvelope, panelClient, required, tellPanel,
} from './test/fixtures';

const SCRIPT_PROPERTY_LEAF_LABELS_DROPPING_THE_BASES_WORDS: Record<string, string> = {
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
  fields: [fieldMeta({ name: 'Object', type: 'formKey' }), fieldMeta({ name: 'Alias', type: 'int' })],
  ...extra,
});

const leafTypedDataMetaShapedAsItsFirstLeaf: FieldMetadata = fieldMeta({
  name: 'Data', type: 'bool',
  variants: {
    ScriptBoolProperty: fieldMeta({ name: 'Data', type: 'bool' }),
    ScriptFloatProperty: fieldMeta({ name: 'Data', type: 'float' }),
    ScriptIntProperty: fieldMeta({ name: 'Data', type: 'int' }),
    ScriptStringProperty: fieldMeta({ name: 'Data', type: 'string' }),
    ScriptStringListProperty: fieldMeta({ name: 'Data', type: 'array', isArray: true, elementType: fieldMeta({ name: '', type: 'string' }) }),
  },
});

const propertyMeta = fieldMeta({
  name: '', type: 'struct',
  leafTypeName: 'ScriptProperty',
  fields: [
    fieldMeta({ name: 'Name', type: 'string' }),
    fieldMeta({ name: 'Flags', type: 'flags', enumMembers: [{ value: 'Edited', bitValue: '1', label: null }] }),
    leafTypedDataMetaShapedAsItsFirstLeaf,
    fieldMeta({ name: 'Object', type: 'formKey' }),
    fieldMeta({ name: 'Alias', type: 'int' }),
    fieldMeta({ name: 'Objects', type: 'array', isArray: true, elementType: objectBindingMeta('') }),
    fieldMeta({
      name: 'MutagenObjectType', type: 'enum',
      displayLabel: 'Kind', isDiscriminator: true,
      enumMembers: Object.entries(SCRIPT_PROPERTY_LEAF_LABELS_DROPPING_THE_BASES_WORDS).map(([value, label]) => ({ value, bitValue: null, label })),
    }),
  ],
});

const FALLOUT4_VMAD_ANNOTATIONS_KEYED_ARRAYS = { scripts: ['Name'], properties: ['Name'], aliases: ['Property.Alias'] };

const scriptsMeta = fieldMeta({
  name: 'Scripts', type: 'array', isArray: true,
  keyMembers: FALLOUT4_VMAD_ANNOTATIONS_KEYED_ARRAYS.scripts,
  elementType: fieldMeta({
    name: '', type: 'struct',
    leafTypeName: 'ScriptEntry',
    fields: [
      fieldMeta({ name: 'Name', type: 'string' }),
      fieldMeta({ name: 'Flags', type: 'enum', enumMembers: [{ value: 'Local', bitValue: null, label: null }] }),
      fieldMeta({ name: 'Properties', type: 'array', isArray: true, keyMembers: FALLOUT4_VMAD_ANNOTATIONS_KEYED_ARRAYS.properties, elementType: propertyMeta }),
    ],
  }),
});

const aliasesMeta = fieldMeta({
  name: 'Aliases', type: 'array', isArray: true,
  keyMembers: FALLOUT4_VMAD_ANNOTATIONS_KEYED_ARRAYS.aliases,
  elementType: fieldMeta({
    name: '', type: 'struct',
    leafTypeName: 'QuestFragmentAlias',
    fields: [objectBindingMeta('Property'), scriptsMeta],
  }),
});

type Obj = Record<string, unknown>;

const documentSpelledProperty = (name: string, concreteType: string, over: Obj = {}): Obj => ({
  MutagenObjectType: concreteType, Name: name, Flags: ['Edited'],
  ...over,
});

const script = (name: string, properties: (Obj | null)[] = []): Obj => ({ Name: name, Flags: 'Local', Properties: properties });

const PLUGIN = 'MyMod.esp';

const compareResult = (
  byColumn: Record<string, Obj[]>, editorIds: Record<string, string> = {}, meta: FieldMetadata = scriptsMeta,
): CompareResult => fieldCompared(meta, byColumn, { formKey: '000001:MyMod.esp', editorId: 'TestNpc', editorIds });

const oneColumn = (scripts: Obj[], editorIds: Record<string, string> = {}, meta: FieldMetadata = scriptsMeta) =>
  compareResult({ [PLUGIN]: scripts }, editorIds, meta);

let currentCompare: CompareResult = compareResultFixture();

function renderPanel() {
  return render(<RecordPanel client={panelClient(() => currentCompare, {
    plugins: [{ name: PLUGIN, isCompiledPlugin: true }],
  })} />);
}

const fieldCell = (field: string): HTMLTableCellElement =>
  required(screen.getAllByText(field).find((el): el is HTMLTableCellElement => el.tagName === 'TD'), `the row named ${field}`);

const rowOf = (el: Element): HTMLTableRowElement => required(el.closest('tr'), 'the row');

const cellAt = (row: Element, index: number): HTMLTableCellElement => required(row.querySelectorAll('td')[index], `the row's cell ${index}`);

const summaryOf = (field: string): string => cellAt(rowOf(fieldCell(field)), 1).textContent;

const toggleRow = (field: string) => {
  fireEvent.click(required(rowOf(fieldCell(field)).querySelector('button'), `${field}'s toggle`));
};

async function openScripts() {
  await waitFor(() => screen.getByText('Scripts'));
}

const lastEnvelope = () => lastPostedEnvelope(vscode.postMessage);

function reloadWith(compare: CompareResult) {
  currentCompare = compare;
  tellPanel({ type: EXTENSION_TO_WEBVIEW.LOAD_RECORD, formKey: '000001:MyMod.esp' });
}

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
  vi.mocked(vscode.postMessage).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('collapsedReading of a script', () => {
  const scriptElementType = required(scriptsMeta.elementType, "scriptsMeta's elementType");
  const scriptElementFields = required(scriptElementType.fields, "scriptsMeta's element fields");
  const propertyFields = required(propertyMeta.fields, "propertyMeta's fields");
  const objectBinding = required(propertyFields.find(f => f.name === 'Objects')?.elementType, "propertyMeta's Objects elementType");
  const aliasProperty = required(aliasesMeta.elementType?.fields?.find(f => f.name === 'Property'), "aliasesMeta's Property");
  const ofUnknownLeaf = (propertiesOver: Partial<FieldMetadata> = {}): FieldMetadata => ({
    ...scriptsMeta,
    elementType: {
      ...scriptElementType,
      fields: scriptElementFields.map(f => (f.name !== 'Properties' ? f : {
        ...f, ...propertiesOver,
        elementType: { ...propertyMeta, leafTypeName: 'SomethingElse', fields: propertyFields.filter(m => !m.isDiscriminator) },
      })),
    },
  });
  const unkeyedUnknownLeaf = ofUnknownLeaf({ keyMembers: null });
  const keyedUnknownLeaf = ofUnknownLeaf();
  const unkeyedAliases: FieldMetadata = { ...aliasesMeta, keyMembers: null };
  const unnamed = documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 10 });
  delete unnamed.MutagenObjectType;
  const twoUnnamed = [script('Guard', [unnamed, { ...unnamed, Name: 'Speed' }])];
  const playerRef = { '00000014:Fallout4.esm': 'PlayerRef' };
  const owner = (alias: number) => [script('Guard', [documentSpelledProperty('Owner', 'ScriptObjectProperty', {
    Object: '00000014:Fallout4.esm', Alias: alias,
  })])];
  const intRadius = documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 10 });
  const aliasOf = (property: Obj): Obj[] => [{ Property: property, Scripts: [] }];
  const threeProperties = [script('Guard', [
    intRadius,
    documentSpelledProperty('Rate', 'ScriptFloatProperty', { Data: 2.5 }),
    documentSpelledProperty('Tag', 'ScriptStringProperty', { Data: 'alpha' }),
  ])];
  const element = (diff: FieldDiff, index: number): FieldDiff => required(diff.children?.[index], `element ${index}`);
  const member = (diff: FieldDiff, name: string): FieldDiff => required(diff.children?.find(c => c.fieldName === name), `member ${name}`);
  const scriptKeys = scriptsMeta.keyMembers;
  const propertyKeys = FALLOUT4_VMAD_ANNOTATIONS_KEYED_ARRAYS.properties;

  interface Row {
    name: string; scripts: Obj[]; meta: FieldMetadata; editorIds?: Record<string, string>;
    diff: (top: FieldDiff) => FieldDiff; at: FieldMetadata | undefined; keyMembers: readonly string[] | null | undefined; reads: string;
  }
  const scriptRow = (name: string, scripts: Obj[], reads: string, editorIds?: Record<string, string>): Row => ({
    name, scripts, meta: scriptsMeta, editorIds, diff: top => element(top, 0), at: scriptElementType, keyMembers: scriptKeys, reads,
  });
  const propertyRow = (name: string, index: number, reads: string): Row => ({
    name, scripts: threeProperties, meta: scriptsMeta, diff: top => element(member(element(top, 0), 'Properties'), index),
    at: propertyMeta, keyMembers: propertyKeys, reads,
  });
  const rows: Row[] = [
    scriptRow('a script reads under its own name with every property passed through, not counted',
      [script('Guard', [documentSpelledProperty('Awake', 'ScriptBoolProperty', { Data: true }), intRadius])],
      'Guard(Awake: Bool = True, Radius: Int = 10)'),
    scriptRow('a script with no properties reads as its own name and an empty list', [script('Bare')], 'Bare()'),
    propertyRow('an int property reads name, kind and value, the kind coming from the schema\'s own leaf label', 0, 'Radius: Int = 10'),
    propertyRow('a float property reads name, kind and value', 1, 'Rate: Float = 2.5'),
    propertyRow('a string property reads name, kind and value', 2, 'Tag: String = alpha'),
    { name: 'an object binding reads as the bound record\'s own cell text and its alias slot',
      scripts: [script('Guard', [documentSpelledProperty('Owner', 'ScriptObjectListProperty', {
        Objects: [{ Object: '00000014:Fallout4.esm', Alias: -1 }],
      })])],
      meta: scriptsMeta, editorIds: playerRef,
      diff: top => element(member(element(member(element(top, 0), 'Properties'), 0), 'Objects'), 0),
      at: objectBinding, keyMembers: undefined, reads: 'PlayerRef [00000014:Fallout4.esm], Alias[None]' },
    scriptRow('the same binding read as a property of its own takes the property\'s shape around it, alias -1 reading None',
      owner(-1), 'Guard(Owner: Object = PlayerRef [00000014:Fallout4.esm], Alias[None])', playerRef),
    scriptRow('the alias slot -2 reads as Player', owner(-2), 'Guard(Owner: Object = PlayerRef [00000014:Fallout4.esm], Alias[Player])', playerRef),
    scriptRow('any other alias slot reads as its number', owner(3), 'Guard(Owner: Object = PlayerRef [00000014:Fallout4.esm], Alias[3])', playerRef),
    scriptRow('a property whose value is a list reads by name and kind alone, its elements having their own rows',
      [script('Guard', [documentSpelledProperty('Names', 'ScriptStringListProperty', { Data: ['a', 'b'] })])], 'Guard(Names: String List)'),
    scriptRow('a leaf the table has no reading of its own for reads by its declared base\'s',
      [script('Guard', [documentSpelledProperty('V', 'ScriptVariableProperty')])], 'Guard(V: Variable)'),
    { ...scriptRow('an element of a passed-through list whose leaf has no reading at all still occupies its place', twoUnnamed, 'Guard({…}, {…})'),
      meta: unkeyedUnknownLeaf, at: unkeyedUnknownLeaf.elementType ?? undefined },
    { ...scriptRow('a keyed element of a passed-through list whose leaf has no reading reads as its key', twoUnnamed, 'Guard(Radius, Speed)'),
      meta: keyedUnknownLeaf, at: keyedUnknownLeaf.elementType ?? undefined },
    scriptRow('a null slot of a passed-through list holds its place, so the count stays true',
      [script('Guard', [null, intRadius])], 'Guard({…}, Radius: Int = 10)'),
    scriptRow('the concrete base is a leaf like any other and reads with no value',
      [script('Guard', [documentSpelledProperty('Nothing', 'ScriptProperty')])], 'Guard(Nothing: Script Property)'),
    { name: 'an array with one element reads as that element', scripts: [script('Guard', [intRadius])], meta: scriptsMeta,
      diff: top => top, at: scriptsMeta, keyMembers: undefined, reads: 'Guard(Radius: Int = 10)' },
    { name: 'an array whose one element has no reading reads as that element does', scripts: aliasOf({ Alias: 0 }), meta: unkeyedAliases,
      diff: top => top, at: unkeyedAliases, keyMembers: undefined, reads: '{…}' },
    { name: 'an array whose one element has a dotted key reads as that key, one struct member down', scripts: aliasOf({ Alias: 7 }), meta: aliasesMeta,
      diff: top => top, at: aliasesMeta, keyMembers: undefined, reads: '7' },
    { name: 'a struct member with a reading of its own reads by it',
      scripts: aliasOf({ Object: '00000014:Fallout4.esm', Alias: -2 }), meta: aliasesMeta, editorIds: playerRef,
      diff: top => member(element(top, 0), 'Property'), at: aliasProperty, keyMembers: undefined,
      reads: 'PlayerRef [00000014:Fallout4.esm], Alias[Player]' },
  ];

  it.each(rows)('$name', ({ scripts, editorIds, meta, diff, at, keyMembers, reads }) => {
    const top = required(oneColumn(scripts, editorIds, meta).diffs[0], 'the array diff');

    expect(collapsedReading(diff(top), at, PLUGIN, 'English', true, keyMembers).text).toBe(reads);
  });
});

describe('a collapsed array reads by its elements', () => {

  it('counts its elements per column, so one column reads its one element where another reads the count', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [script('Guard')],
      'Other.esp': [script('Ambush'), script('Guard')],
    });
    renderPanel();
    await openScripts();
    toggleRow('Scripts');

    const scripts = rowOf(fieldCell('Scripts'));
    expect(cellAt(scripts, 1).textContent).toBe('Guard()');
    expect(cellAt(scripts, 2).textContent).toBe('[2]');
  });

  it('an array whose one element is a plain value reads as that value, each column by its own leaf\'s shape', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [script('Guard', [documentSpelledProperty('Names', 'ScriptStringListProperty', { Data: ['alpha'] })])],
      'Other.esp': [script('Guard', [documentSpelledProperty('Names', 'ScriptIntProperty', { Data: 3 })])],
    });
    renderPanel();
    await waitFor(() => fieldCell('Data'));
    toggleRow('Data');

    const data = rowOf(fieldCell('Data'));
    expect(cellAt(data, 1).textContent).toBe('alpha');
    expect(cellAt(data, 2).textContent).toBe('3');
  });
});

describe('a row of a keyed array is identified by its key', () => {
  it('collapsing one script and then losing it leaves the later script expanded', async () => {
    currentCompare = oneColumn([
      script('Ambush', [documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 10 })]),
      script('Guard', [documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 20 })]),
    ]);
    renderPanel();
    await openScripts();
    await waitFor(() => fieldCell('Guard'));
    toggleRow('Ambush');
    toggleRow('Radius');

    reloadWith(oneColumn([script('Guard', [documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 20 })])]));
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
    await waitFor(() => fieldCell('Second'));
    toggleRow('0');
    toggleRow('Second');

    reloadWith(oneColumn([alias(1, 'Second')], {}, aliasesMeta));
    await waitFor(() => expect(screen.queryByText('0')).not.toBeInTheDocument());

    expect(summaryOf('Second')).toBe('Second()');
  });

  it('two scripts sharing a property name keep their own rows apart', async () => {
    currentCompare = oneColumn([
      script('Ambush', [documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 10 })]),
      script('Guard', [documentSpelledProperty('Radius', 'ScriptIntProperty', { Data: 20 })]),
    ]);
    renderPanel();
    await openScripts();
    await waitFor(() => fieldCell('Ambush'));
    toggleRow('Ambush');
    toggleRow('Guard');

    expect(summaryOf('Ambush')).toBe('Ambush(Radius: Int = 10)');
    expect(summaryOf('Guard')).toBe('Guard(Radius: Int = 20)');

    toggleRow('Ambush');
    await waitFor(() => screen.getAllByText('Properties'));
    expect(screen.getAllByText('Properties')).toHaveLength(1);
    expect(summaryOf('Guard')).toBe('Guard(Radius: Int = 20)');
  });
});

describe('a member the column\'s own leaf does not declare, as Data\'s shape varies by leaf and a leaf the variants do not name has no Data at all, not the base shape\'s default', () => {
  it('renders nothing in that column, beside the value the other column\'s leaf holds', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [script('Guard', [documentSpelledProperty('Owner', 'ScriptIntProperty', { Data: 3 })])],
      'Other.esp': [script('Guard', [documentSpelledProperty('Owner', 'ScriptObjectProperty', { Object: '00000014:Fallout4.esm', Alias: -1 })])],
    });
    renderPanel();
    await openScripts();
    await waitFor(() => screen.getByText('Data'));

    const dataRow = rowOf(fieldCell('Data'));
    expect(cellAt(dataRow, 1).textContent).toBe('3');
    expect(cellAt(dataRow, 2).textContent).toBe('');
  });
});

describe('Add Script is the generic array gesture', () => {
  it('the added script is a row of its own in that plugin’s column, and is nameable there', async () => {
    currentCompare = oneColumn([script('Guard')]);
    renderPanel();
    await openScripts();
    await waitFor(() => fieldCell('Guard'));

    reloadWith(oneColumn([script('Guard'), script('')]));
    await waitFor(() => expect(screen.getAllByText('Name')).toHaveLength(2));

    const added = required(document.querySelectorAll('tbody tr')[2], 'the second script row');
    expect(within(cellAt(added, 0)).getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(cellAt(required(added.nextElementSibling, 'the row beneath the added script'), 0).textContent).toBe('Name');

    const nameCell = cellAt(rowOf(required(screen.getAllByText('Name')[0], 'the Name row')), 1);
    fireEvent.doubleClick(required(nameCell.querySelector('[data-open-trigger]'), "the Name cell's open trigger"));
    const input = required(nameCell.querySelector('input'), "the Name cell's input");
    fireEvent.change(input, { target: { value: 'Ambush' } });
    fireEvent.blur(input);

    expect(lastEnvelope()).toEqual({
      op: 'set',
      path: [{ kind: 'member', name: 'Scripts' }, { kind: 'index', index: 1 }, { kind: 'member', name: 'Name' }],
      value: 'Ambush',
    });
  });

});
