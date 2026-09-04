import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldDiff, FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION } from './messages';

// #695: what a script, a script property and a script object binding read as while collapsed, and
// what a row of a keyed array is identified by.
//
// The metadata below is the Fallout 4 schema's own shape, from MEditService.Tests'
// ConcreteBaseUnionSchemaTests (the fifteen-leaf `concrete_type`, `data` split one field per shape,
// the object leaf's flattened `object`/`alias`) and LeafTypeNameSchemaTests (`ScriptEntry`,
// `ScriptProperty`, `ScriptObjectProperty` as declared type names) — trimmed to the leaves these
// cases name. The keyed arrays and their key members are Fallout4VmadAnnotations.KeyedArrays.

const field = (name: string, type: string, extra: Partial<FieldMetadata> = {}): FieldMetadata =>
  ({ name, type: type as FieldMetadata['type'], isArray: false, validFormKeyTypes: [], enumMembers: [], ...extra });

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
};

const objectBindingMeta = (name: string, extra: Partial<FieldMetadata> = {}): FieldMetadata => ({
  name, type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
  leafTypeName: 'ScriptObjectProperty',
  fields: [field('object', 'formKey'), field('alias', 'int')],
  ...extra,
});

const propertyMeta: FieldMetadata = {
  name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
  leafTypeName: 'ScriptProperty',
  fields: [
    field('name', 'string'),
    field('flags', 'enum', { enumMembers: [{ value: 'Edited', bitValue: '1', label: null }] }),
    field('data_bool', 'bool'),
    field('data_float', 'float'),
    field('data_int', 'int'),
    field('data_string', 'string'),
    field('data_string_array', 'array', { isArray: true, elementType: field('', 'string') }),
    field('object', 'formKey'),
    field('alias', 'int'),
    field('objects', 'array', { isArray: true, elementType: objectBindingMeta('') }),
    field('concrete_type', 'enum', {
      displayLabel: 'Kind', isDiscriminator: true,
      enumMembers: Object.entries(PROPERTY_LEAVES).map(([value, label]) => ({ value, bitValue: null, label })),
    }),
  ],
};

const scriptsMeta: FieldMetadata = {
  name: 'scripts', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
  keyMembers: ['name'],
  elementType: {
    name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
    leafTypeName: 'ScriptEntry',
    fields: [
      field('name', 'string'),
      field('flags', 'enum', { enumMembers: [{ value: 'Local', bitValue: '1', label: null }] }),
      field('properties', 'array', { isArray: true, keyMembers: ['name'], elementType: propertyMeta }),
    ],
  },
};

type Obj = Record<string, unknown>;

/** A property of one leaf: the discriminator, the name, and whichever member that leaf keeps its
 *  value in. Every other member of the sparse union reads null off it, exactly as the wire sends. */
const property = (name: string, concreteType: string, over: Obj = {}): Obj => ({
  name, flags: 1, concrete_type: concreteType,
  data_bool: null, data_float: null, data_int: null, data_string: null, data_string_array: null,
  object: null, alias: null, objects: null,
  ...over,
});

const script = (name: string, properties: Obj[] = []): Obj => ({ name, flags: 1, properties });

const PLUGIN = 'MyMod.esp';

// ── Building the diff the panel renders ──────────────────────────────────────
//
// Driven by the metadata rather than by the values, so a member a column leaves null still has its
// row and its per-column values — which is what the union-aligned tree the backend sends looks
// like. Keyed array children are named by their key text (ElementKey.Text), positional ones by
// "[N]"; the two together are what "keyed row identity" is a claim about.

/** ElementKey.Text: the element's key members, joined the way the backend joins them. */
const keyTextOf = (keyMembers: string[], element: unknown): string =>
  keyMembers.map(m => String((element as Obj)[m] ?? '')).join(' / ');

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

  return {
    fieldName,
    values,
    winnerColumn: columns[0],
    winnerValue: values[columns[0]],
    cellStates: {},
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
  };
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
  const client: RecordPanelClient = {
    load: vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      result: currentCompare,
      immutableSet: new Set(),
      notInLoadOrderSet: new Set(),
      trackedSet: new Set([columnKey(PLUGIN, null)]),
      conflictsComputed: true,
    } as unknown as LoadResult)),
  };
  return render(<RecordPanel client={client} />);
}

/** The Field-column cell of the row that reads `field`. */
function fieldCell(field: string): HTMLTableCellElement {
  const td = screen.getAllByText(field).find(el => el.tagName === 'TD');
  expect(td, `no row named ${field}`).toBeDefined();
  return td as HTMLTableCellElement;
}

/** What that row's one column reads out. */
const summaryOf = (field: string): string =>
  fieldCell(field).closest('tr')!.querySelectorAll('td')[1].textContent ?? '';

const expandRow = (field: string) =>
  fireEvent.click(fieldCell(field).closest('tr')!.querySelector('button')!);

async function expandScripts() {
  await waitFor(() => screen.getByText('scripts'));
  fireEvent.click(screen.getAllByText('▶')[0]);
}

/** The panel re-reads the record, the way it does after any write lands. */
function reloadWith(compare: unknown) {
  currentCompare = compare;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: EXTENSION_TO_WEBVIEW.RECORD_EDITED, formKey: '000001:MyMod.esp' },
  }));
}

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
  (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

// ── AC1: the three summary shapes ────────────────────────────────────────────

describe('#695 — a collapsed script reads as xEdit prose', () => {
  it('a script reads under its own name with every property passed through, not counted', async () => {
    currentCompare = oneColumn([script('Guard', [
      property('Awake', 'ScriptBoolProperty', { data_bool: true }),
      property('Radius', 'ScriptIntProperty', { data_int: 10 }),
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
      property('Radius', 'ScriptIntProperty', { data_int: 10 }),
      property('Rate', 'ScriptFloatProperty', { data_float: 2.5 }),
      property('Tag', 'ScriptStringProperty', { data_string: 'alpha' }),
    ])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('properties'));
    expandRow('properties');
    await waitFor(() => screen.getByText('Radius'));

    expect(summaryOf('Radius')).toBe('Radius: Int = 10');
    expect(summaryOf('Rate')).toBe('Rate: Float = 2.5');
    expect(summaryOf('Tag')).toBe('Tag: String = alpha');
  });

  it('an object binding reads as the bound record’s own cell text and its alias slot', async () => {
    currentCompare = oneColumn(
      [script('Guard', [property('Owner', 'ScriptObjectListProperty', {
        objects: [{ object: '00000014:Fallout4.esm', alias: -1 }],
      })])],
      { '00000014:Fallout4.esm': 'PlayerRef' },
    );
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('properties'));
    expandRow('properties');
    await waitFor(() => screen.getByText('Owner'));
    expandRow('Owner');
    await waitFor(() => screen.getByText('objects'));
    expandRow('objects');
    await waitFor(() => screen.getByText('[0]'));

    expect(summaryOf('[0]')).toBe('PlayerRef [00000014:Fallout4.esm], Alias[None]');
  });

  it('the same binding read as a property of its own takes the property’s shape around it', async () => {
    currentCompare = oneColumn(
      [script('Guard', [property('Owner', 'ScriptObjectProperty', {
        object: '00000014:Fallout4.esm', alias: -1,
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
      property('Names', 'ScriptStringListProperty', { data_string_array: ['a', 'b'] }),
    ])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard(Names: String List)');
  });

  it('the concrete base is a leaf like any other and reads with no value', async () => {
    currentCompare = oneColumn([script('Guard', [property('Nothing', 'ScriptProperty')])]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    expect(summaryOf('Guard')).toBe('Guard(Nothing: Script Property)');
  });
});

// ── AC1: alias display ───────────────────────────────────────────────────────

describe('#695 — the alias slot of an object binding', () => {
  const withAlias = (alias: number) => oneColumn(
    [script('Guard', [property('Owner', 'ScriptObjectProperty', {
      object: '00000014:Fallout4.esm', alias,
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

// ── AC1: keyed row identity under a sibling remove ───────────────────────────

describe('#695 — a row of a keyed array is identified by its key', () => {
  it('expanding one script and then losing an earlier sibling leaves that script expanded', async () => {
    currentCompare = oneColumn([
      script('Ambush', [property('Radius', 'ScriptIntProperty', { data_int: 10 })]),
      script('Guard', [property('Radius', 'ScriptIntProperty', { data_int: 20 })]),
    ]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));
    expandRow('Guard');
    await waitFor(() => screen.getByText('properties'));
    expandRow('properties');
    await waitFor(() => screen.getByText('Radius'));

    // The compare the panel re-reads after a remove of the earlier sibling. Guard now sits where
    // Ambush did: identity by key survives that, identity by position does not.
    reloadWith(oneColumn([script('Guard', [property('Radius', 'ScriptIntProperty', { data_int: 20 })])]));
    await waitFor(() => expect(screen.queryByText('Ambush')).not.toBeInTheDocument());

    expect(screen.getByText('properties')).toBeInTheDocument();
    expect(summaryOf('Radius')).toBe('Radius: Int = 20');
  });

  it('two scripts sharing a property name keep their own rows apart', async () => {
    currentCompare = oneColumn([
      script('Ambush', [property('Radius', 'ScriptIntProperty', { data_int: 10 })]),
      script('Guard', [property('Radius', 'ScriptIntProperty', { data_int: 20 })]),
    ]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Ambush'));

    expect(summaryOf('Ambush')).toBe('Ambush(Radius: Int = 10)');
    expect(summaryOf('Guard')).toBe('Guard(Radius: Int = 20)');

    // Expanding one leaves the other collapsed — a row is its own key's, not its position's.
    expandRow('Ambush');
    await waitFor(() => screen.getAllByText('properties'));
    expect(screen.getAllByText('properties')).toHaveLength(1);
    expect(summaryOf('Guard')).toBe('Guard(Radius: Int = 20)');
  });
});

// ── AC4: Add on the scripts array ────────────────────────────────────────────

describe('#695 — Add Script is the generic array gesture', () => {
  // The panel half of one gesture; MEditService.Tests' VmadEditTests
  // (AddingAScript_StoresEveryScriptInKeyOrder_AndTouchesNothingElse and
  // AFreshlyAddedScriptIsAddressableByItsEmptyKey) feed this same envelope through EditField and
  // assert what lands. The webview contributes no element: a new script's key is empty until the
  // user names it, so it appears first and is then nameable.
  it('posts the array op and no element of its own', async () => {
    currentCompare = oneColumn([script('Guard')]);
    renderPanel();
    await waitFor(() => screen.getByText('scripts'));

    const cell = screen.getAllByText('[1]')[0].closest('td')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: 'Insert' });

    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const posted = [...calls].reverse()
      .find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)?.[0] as
      { fieldPath?: string; value?: unknown } | undefined;
    expect(posted?.fieldPath).toBe('scripts');
    expect(posted?.value).toEqual({ op: 'array_add', path: [] });
  });

  it('the added script is a row of its own in that plugin’s column, and is nameable there', async () => {
    currentCompare = oneColumn([script('Guard')]);
    renderPanel();
    await expandScripts();
    await waitFor(() => screen.getByText('Guard'));

    // What the panel re-reads once the write lands: the new script's key is empty until the user
    // names it (#710), so it sorts first and its row is named by that empty key.
    reloadWith(oneColumn([script(''), script('Guard')]));
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(3));

    // First of the two script rows, since the empty key sorts before every named one.
    const added = document.querySelectorAll('tbody tr')[1];
    // Its Field column holds nothing but the disclosure control: the key is still empty.
    expect(added.querySelectorAll('td')[0].textContent).toBe('▶');
    expect(added.querySelectorAll('td')[1].textContent).toBe('()');

    // Nameable: its own `name` cell takes an edit like any other string cell, and the whole
    // scripts field commits with the name on the element that had none.
    fireEvent.click(added.querySelector('button')!);
    await waitFor(() => screen.getAllByText('name'));
    const nameCell = screen.getAllByText('name')[0].closest('tr')!.querySelectorAll('td')[1];
    fireEvent.doubleClick(nameCell.querySelector('[data-open-trigger]')!);
    const input = nameCell.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Ambush' } });
    fireEvent.blur(input);

    const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const edit = [...calls].reverse()
      .find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD)?.[0] as
      { fieldPath?: string; value?: Obj[] } | undefined;
    expect(edit?.fieldPath).toBe('scripts');
    expect(edit?.value?.map(e => e.name)).toEqual(['Ambush', 'Guard']);
  });
});
