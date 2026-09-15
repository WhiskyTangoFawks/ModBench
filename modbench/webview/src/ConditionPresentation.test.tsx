import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { CompareResult, FieldDiff, FieldMetadata } from './types';
import { vscode } from './vscode';
import {
  compareOverride, compareResultFixture, diffNode, fieldMeta, leafMeta as leaf, panelClient,
  postedEnvelopes as sharedPostedEnvelopes, required,
} from './test/fixtures';

// The metadata below is the Fallout 4 schema's own shape, trimmed to the enum members these
// cases name and never restructured; `siblingsInUse` rows come from Condition.GetParameterTypes.

const RUN_ON_VALUES = ['Subject', 'Target', 'Reference', 'CombatTarget'];

// Only the functions these cases use; each maps to the members Mutagen's own GetParameterTypes
// picks for it.
const FUNCTION_SLOTS: Record<string, string[]> = {
  GetStageDone: ['ParameterOneRecord', 'ParameterTwoNumber'],
  HasKeyword: ['ParameterOneRecord'],
  GetVATSValue: ['ParameterOneNumber', 'ParameterTwoNumber'],
  IsSneaking: [],
  GetGraphVariableFloat: ['ParameterOneString'],
  GetVMQuestVariable: ['ParameterOneRecord', 'ParameterTwoString'],
  HasAssociationType: ['ParameterOneRecord', 'ParameterTwoRecord'],
};

const dataMeta = fieldMeta({
  name: 'Data', type: 'struct',
  leafTypeName: 'ConditionData',
  fields: [
    leaf('RunOnType', 'enum', {
      default: 'Subject',
      enumMembers: RUN_ON_VALUES.map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: Object.fromEntries(RUN_ON_VALUES.map(v => [v, v === 'Reference' ? ['Reference'] : []])),
    }),
    leaf('Reference', 'formKey'),
    leaf('Unknown3', 'int'),
    leaf('Function', 'enum', {
      enumMembers: Object.keys(FUNCTION_SLOTS).map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: FUNCTION_SLOTS,
    }),
    leaf('ParameterOneRecord', 'formKey'),
    leaf('ParameterOneNumber', 'int'),
    leaf('ParameterOneString', 'string'),
    leaf('ParameterTwoRecord', 'formKey'),
    leaf('ParameterTwoNumber', 'int'),
    leaf('ParameterTwoString', 'string'),
    leaf('EventFunction', 'int'),
    leaf('EventMember', 'int'),
    leaf('Parameter3', 'formKey'),
    leaf('MutagenObjectType', 'enum', {
      displayLabel: 'Kind', isDiscriminator: true,
      enumMembers: [
        { value: 'FunctionConditionData', bitValue: null, label: 'Function' },
        { value: 'GetEventData', bitValue: null, label: 'Get Event' },
      ],
    }),
  ],
});

// ComparisonValue is one member whose type the leaf decides; the variant per leaf is what the
// backend's schema carries, and the field's own shape is the first leaf's.
const comparisonValueMeta: FieldMetadata = leaf('ComparisonValue', 'float', {
  variants: { ConditionFloat: leaf('ComparisonValue', 'float'), ConditionGlobal: leaf('ComparisonValue', 'formKey') },
});

const conditionsMeta = fieldMeta({
  name: 'Conditions', type: 'array', isArray: true,
  elementType: fieldMeta({
    name: '', type: 'struct',
    leafTypeName: 'Condition',
    fields: [
      dataMeta,
      leaf('CompareOperator', 'enum', {
        enumMembers: ['EqualTo', 'NotEqualTo', 'GreaterThan', 'GreaterThanOrEqualTo', 'LessThan', 'LessThanOrEqualTo']
          .map(value => ({ value, bitValue: null, label: null })),
      }),
      leaf('Flags', 'flags', {
        enumMembers: [
          { value: 'OR', bitValue: '1', label: null },
          { value: 'ParametersUseAliases', bitValue: '2', label: null },
        ],
      }),
      comparisonValueMeta,
      leaf('MutagenObjectType', 'enum', {
        displayLabel: 'Kind', isDiscriminator: true,
        enumMembers: [
          { value: 'ConditionFloat', bitValue: null, label: 'Float' },
          { value: 'ConditionGlobal', bitValue: null, label: 'Global' },
        ],
      }),
    ],
  }),
});

// conditionsMeta declares its elementType and that type's fields literally above — every use
// below is reading back what this file just built.
const conditionsElementType = required(conditionsMeta.elementType, "conditionsMeta's elementType");
const conditionsElementTypeFields = required(conditionsElementType.fields, "conditionsMeta's elementType fields");

type Condition = Record<string, unknown>;

// Every member lookup below walks a plain JS structure this file itself built — `Reflect.get`
// on the guarded `object` reads a member without narrowing away from `unknown`.
function propertyOf(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

// The document's own spelling: a member at its default is omitted, flags are the names carried.
const condition = (over: Condition = {}, data: Condition = {}): Condition => ({
  MutagenObjectType: 'ConditionFloat',
  CompareOperator: 'EqualTo',
  Flags: [],
  ComparisonValue: 1,
  Data: {
    MutagenObjectType: 'FunctionConditionData',
    RunOnType: 'Subject',
    Unknown3: -1,
    Function: 'IsSneaking',
    ...data,
  },
  ...over,
});

const PLUGIN = 'MyMod.esp';

// Member diffs are derived from the values themselves, so a case states its conditions alone.
function compareResult(
  byColumn: Record<string, Condition[]>, resolutions: Record<string, string> = {},
  meta: FieldMetadata = conditionsMeta,
): CompareResult {
  const columns = Object.keys(byColumn);
  const at = (column: string, index: number, path: string[]): unknown => {
    const rows = byColumn[column];
    if (!rows) throw new Error(`compareResult: no rows recorded for column "${column}"`);
    return path.reduce<unknown>((v, name) => propertyOf(v, name), rows[index]);
  };

  const resolutionsFor = (path: string[], index: number) => {
    // Object.fromEntries falls back to an `any`-returning overload unless the entries array is
    // a genuine tuple array, hence the explicit map return type.
    const entries = columns
      .map(c => [c, at(c, index, path)] as const)
      .filter(([, v]) => typeof v === 'string' && resolutions[v])
      .map(([c, v]): [string, { state: 'ResolvedValidType'; recordType: null; editorId: string | undefined }] =>
        [c, { state: 'ResolvedValidType', recordType: null, editorId: resolutions[String(v)] }]);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  const valuesFor = (path: string[], index: number) =>
    Object.fromEntries(columns.map(c => [c, at(c, index, path) ?? null]));

  // A row exists for any member some column carries, as the backend's classifier aligns them; a
  // document omits a member at its default, so the keys are the union across columns.
  const memberDiffs = (path: string[], index: number): FieldDiff[] => {
    const keys = [...new Set(columns.flatMap(c => {
      const value = at(c, index, path);
      return Object.keys(typeof value === 'object' && value !== null ? value : {});
    }))];
    return keys.map(name => diffNode({
      fieldName: name,
      values: valuesFor([...path, name], index),
      winnerColumn: columns[0], cellStates: {},
      resolutions: resolutionsFor([...path, name], index),
      children: name === 'Data' ? memberDiffs([...path, name], index) : undefined,
    }));
  };

  const [firstColumn] = columns;
  if (!firstColumn) throw new Error('compareResult: at least one column expected');
  const firstColumnRows = byColumn[firstColumn];
  if (!firstColumnRows) throw new Error(`compareResult: no rows recorded for column "${firstColumn}"`);

  return compareResultFixture({
    conflictAll: 'NoConflict',
    overrides: columns.map((plugin, i) => compareOverride({
      formKey: '000001:MyMod.esp', plugin,
      loadOrderIndex: i + 1, isWinner: i === 0, editorId: 'TestCobj',
      fields: [{ metadata: meta, value: byColumn[plugin] }], conflictThis: 'Master',
    })),
    diffs: [diffNode({
      fieldName: 'Conditions',
      values: Object.fromEntries(columns.map(c => [c, byColumn[c]])),
      winnerColumn: columns[0], cellStates: {},
      children: firstColumnRows.map((_, i) => diffNode({
        fieldName: `[${i}]`,
        values: valuesFor([], i),
        winnerColumn: columns[0], cellStates: {},
        children: memberDiffs([], i),
      })),
    })],
  });
}

const oneColumn = (
  elements: Condition[], resolutions: Record<string, string> = {}, meta: FieldMetadata = conditionsMeta,
) => compareResult({ [PLUGIN]: elements }, resolutions, meta);

let currentCompare: CompareResult = compareResultFixture();

function renderPanel() {
  return render(<RecordPanel client={panelClient(() => currentCompare, {
    plugins: [{ name: PLUGIN, isTracked: true }],
  })} />);
}

async function expandConditions() {
  await waitFor(() => screen.getByText('Conditions'));
  const [trigger] = screen.getAllByText('▶');
  if (!trigger) throw new Error('the collapse triangle getAllByText should have found');
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
}

function summaryOf(index: number): string {
  const td = screen.getAllByText(`[${index}]`).find(el => el.tagName === 'TD');
  if (!td) throw new Error(`the [${index}] row cell`);
  const row = td.closest('tr');
  if (!row) throw new Error(`the [${index}] row`);
  const cells = Array.from(row.querySelectorAll('td'));
  const summaryCell = cells[1];
  if (!summaryCell) throw new Error(`the [${index}] row's summary cell`);
  return summaryCell.textContent;
}

// A row's label cell: the member's own name, which a value cell can also read as (the Kind row
// of a FunctionConditionData reads "Function").
const labelCell = (name: string): HTMLElement | undefined =>
  screen.queryAllByText(name).find(el => el.tagName === 'TD');

// The row a `labelCell` names, and the expand button in its own row — the shape every "click to
// expand this member" step below shares.
function expandButtonFor(cell: HTMLElement): HTMLButtonElement {
  const row = cell.closest('tr');
  if (!row) throw new Error("the label cell's row");
  const button = row.querySelector('button');
  if (!button) throw new Error("the row's expand button");
  return button;
}

async function expandFirstConditionData() {
  await expandConditions();
  const element = screen.getAllByText('[0]').find(el => el.tagName === 'TD');
  if (!element) throw new Error('the [0] row cell');
  fireEvent.click(expandButtonFor(element));
  await waitFor(() => expect(labelCell('Data')).toBeDefined());
  const dataCell = labelCell('Data');
  if (!dataCell) throw new Error('the Data row label cell');
  fireEvent.click(expandButtonFor(dataCell));
  await waitFor(() => expect(labelCell('Function')).toBeDefined());
}

async function openMemberEditor(memberName: string): Promise<HTMLTableCellElement> {
  await expandFirstConditionData();
  const labelled = labelCell(memberName);
  if (!labelled) throw new Error(`the ${memberName} row label cell`);
  const row = labelled.closest('tr');
  if (!row) throw new Error(`the ${memberName} row`);
  const cell = row.querySelectorAll('td')[1];
  if (!cell) throw new Error(`the ${memberName} row's value cell`);
  const trigger = cell.querySelector('[data-open-trigger]');
  if (!trigger) throw new Error(`the ${memberName} value cell's open trigger`);
  fireEvent.doubleClick(trigger);
  return cell;
}

const postedEnvelopes = () => sharedPostedEnvelopes(vscode.postMessage);

const dataMember = (name: string) => [
  { kind: 'member', name: 'Conditions' }, { kind: 'index', index: 0 },
  { kind: 'member', name: 'Data' }, { kind: 'member', name },
];

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
  vi.mocked(vscode.postMessage).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('a collapsed condition reads as xEdit prose', () => {
  it('run on, function, both parameter slots, operator, float to six places, and the AND that follows a non-last element', async () => {
    currentCompare = oneColumn(
      [
        condition({}, {
          RunOnType: 'CombatTarget', Function: 'GetStageDone',
          ParameterOneRecord: '00123456:MyMod.esp', ParameterTwoNumber: 10,
        }),
        condition(),
      ],
      { '00123456:MyMod.esp': 'MQ101' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('CombatTarget.GetStageDone(MQ101, 10) = 1.000000 AND');
  });

  it('Run On = Reference renders the reference as its short name in parentheses', async () => {
    currentCompare = oneColumn(
      [condition({}, {
        RunOnType: 'Reference', Reference: '00000014:Fallout4.esm',
        Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp',
      })],
      { '00000014:Fallout4.esm': 'PlayerRef', '00AABBCC:MyMod.esp': 'ArmorKeyword' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('(PlayerRef).HasKeyword(ArmorKeyword) = 1.000000');
  });

  it('a function with no parameters is written without parentheses', async () => {
    currentCompare = oneColumn([condition({ CompareOperator: 'NotEqualTo' }, { Function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking <> 1.000000');
  });

  it('a string parameter is written without parentheses — xEdit ignores the slot, the value has its own row', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'GetGraphVariableFloat', ParameterOneString: 'bAllowRotation',
    })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.GetGraphVariableFloat = 1.000000');
  });

  it('both record slots read as short names', async () => {
    currentCompare = oneColumn(
      [condition({}, {
        Function: 'HasAssociationType',
        ParameterOneRecord: '00000014:Fallout4.esm', ParameterTwoRecord: '00003333:MyMod.esp',
      })],
      { '00000014:Fallout4.esm': 'PlayerRef', '00003333:MyMod.esp': 'MyAssocType' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.HasAssociationType(PlayerRef, MyAssocType) = 1.000000');
  });

  it('a string second parameter drops only itself', async () => {
    currentCompare = oneColumn(
      [condition({}, {
        Function: 'GetVMQuestVariable',
        ParameterOneRecord: '00000F1E:MyMod.esp', ParameterTwoString: '::myVar',
      })],
      { '00000F1E:MyMod.esp': 'MyQuest' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.GetVMQuestVariable(MyQuest) = 1.000000');
  });

  it('a GLOB comparison reads as the global’s short name, not a float', async () => {
    currentCompare = oneColumn(
      [condition({
        MutagenObjectType: 'ConditionGlobal', CompareOperator: 'GreaterThanOrEqualTo',
        ComparisonValue: '00000ABC:MyMod.esp',
      }, { Function: 'IsSneaking' })],
      { '00000ABC:MyMod.esp': 'MyGlobal' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking >= MyGlobal');
  });

  it('the OR flag writes OR, and the last element of the list carries no conjunction at all', async () => {
    currentCompare = oneColumn([
      condition({ Flags: ['OR'] }, { Function: 'IsSneaking' }),
      condition({ Flags: ['OR'] }, { Function: 'IsSneaking' }),
    ]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking = 1.000000 OR');
    expect(summaryOf(1)).toBe('Subject.IsSneaking = 1.000000');
  });

  // "Last" is per column: the last element that column carries, not the last row of the grid.
  it('a column with fewer conditions ends its list where its own last element is', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [condition({}, { Function: 'IsSneaking' }), condition({}, { Function: 'IsSneaking' })],
      'Other.esp': [condition({}, { Function: 'IsSneaking' })],
    });
    renderPanel();
    await expandConditions();

    const td = screen.getAllByText('[0]').find(el => el.tagName === 'TD');
    if (!td) throw new Error('the [0] row cell');
    const row = td.closest('tr');
    if (!row) throw new Error('the [0] row');
    const cells = Array.from(row.querySelectorAll('td'));
    const firstColumnCell = cells[1];
    const secondColumnCell = cells[2];
    if (!firstColumnCell || !secondColumnCell) throw new Error("both columns' [0] row cells");
    expect(firstColumnCell.textContent).toBe('Subject.IsSneaking = 1.000000 AND');
    expect(secondColumnCell.textContent).toBe('Subject.IsSneaking = 1.000000');
  });

  it('the leaf with no function member of its own is named by its own leaf type', async () => {
    // GetEventData is Fallout 4's second ConditionData leaf: it declares no `function`, because it
    // *is* one function. Its own type name is the function's name.
    currentCompare = oneColumn([condition({}, {
      MutagenObjectType: 'GetEventData', Function: null, EventFunction: 0, EventMember: 0,
    })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.GetEventData = 1.000000');
  });

  it('an expanded condition shows its members instead of the summary', async () => {
    currentCompare = oneColumn([condition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();
    fireEvent.click(required(screen.getAllByText('▶')[0], "the first expand toggle"));

    await waitFor(() => screen.getByText('Data'));
    expect(summaryOf(0)).toBe('');
  });
});

// The table's key is the leaf's type name: the discriminator's value where the leaf is a union,
// the schema's declared type name where it is not.

describe('the table keys on the leaf type name', () => {
  // An entry the table already has, so this is a claim about the key alone.
  const notAUnion: FieldMetadata = {
    ...conditionsMeta,
    elementType: {
      ...conditionsElementType,
      leafTypeName: 'ConditionFloat',
      fields: conditionsElementTypeFields.filter(f => !f.isDiscriminator),
    },
  };

  it('reads its summary from the type name the schema declares', async () => {
    const noDiscriminator = condition({}, { Function: 'IsSneaking' });
    delete noDiscriminator.MutagenObjectType;
    currentCompare = oneColumn([noDiscriminator], {}, notAUnion);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking = 1.000000');
  });

  // A union's declared name is its base, and a concrete base is one of its own leaves — so the
  // declared name is a leaf name too, and the wrong one for a payload naming no leaf.
  it('a union whose own value names no leaf keys on nothing, not on the name the schema declares', async () => {
    const declared: FieldMetadata = {
      ...conditionsMeta,
      elementType: { ...conditionsElementType, leafTypeName: 'ConditionFloat' },
    };
    const unnamed = condition({ MutagenObjectType: null }, { Function: 'IsSneaking' });
    currentCompare = oneColumn([unnamed], {}, declared);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('{…}');
  });
});

describe('a condition shows one row per parameter slot in use', () => {
  it('a record-slot function renders ParameterOneRecord and neither of its aliases', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp',
    })]);
    renderPanel();
    await expandFirstConditionData();

    expect(labelCell('ParameterOneRecord')).toBeDefined();
    expect(labelCell('ParameterOneNumber')).toBeUndefined();
    expect(labelCell('ParameterOneString')).toBeUndefined();
    expect(labelCell('ParameterTwoRecord')).toBeUndefined();
    expect(labelCell('ParameterTwoNumber')).toBeUndefined();
    expect(labelCell('ParameterTwoString')).toBeUndefined();
  });

  it('a number-slot function renders ParameterOneNumber and not the record twin sharing its four bytes', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'GetVATSValue', ParameterOneNumber: 10, ParameterTwoNumber: 0,
    })]);
    renderPanel();
    await expandFirstConditionData();

    expect(labelCell('ParameterOneNumber')).toBeDefined();
    expect(labelCell('ParameterTwoNumber')).toBeDefined();
    expect(labelCell('ParameterOneRecord')).toBeUndefined();
    expect(labelCell('ParameterTwoRecord')).toBeUndefined();
  });

  it('Parameter #3 is written whatever the function is, so it is never hidden', async () => {
    currentCompare = oneColumn([condition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await expandFirstConditionData();

    expect(labelCell('Unknown3')).toBeDefined();
  });

  it('the reference row appears only under Run On = Reference', async () => {
    currentCompare = oneColumn([condition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await expandFirstConditionData();

    expect(labelCell('Reference')).toBeUndefined();
  });

  it('a slot any column uses is shown, so a conflicting override never hides its own data', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [condition({}, { Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp' })],
      'Other.esp': [condition({}, { Function: 'GetVATSValue', ParameterOneNumber: 3 })],
    });
    renderPanel();
    await expandFirstConditionData();

    expect(labelCell('ParameterOneRecord')).toBeDefined();
    expect(labelCell('ParameterOneNumber')).toBeDefined();
  });
});

// The cascade is the writer's (ADR-0005): a change to a governing member posts that one leaf, and
// the backend clears the slots the new value idles from the document it holds.
describe('a governing member posts its own value and nothing else', () => {
  it('changing Run On away from Reference posts one set of Run On', async () => {
    currentCompare = oneColumn([condition({}, {
      RunOnType: 'Reference', Reference: '00000014:Fallout4.esm', Function: 'IsSneaking',
    })]);
    renderPanel();
    const cell = await openMemberEditor('RunOnType');

    const select = required(cell.querySelector('select'), "the cell's select");
    fireEvent.change(select, { target: { value: 'Subject' } });
    fireEvent.blur(select);

    expect(postedEnvelopes()).toEqual([{ op: 'set', path: dataMember('RunOnType'), value: 'Subject' }]);
  });

  it('changing the function posts one set of the function, no emptied slots beside it', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'GetGraphVariableFloat', ParameterOneString: 'bAllowRotation',
    })]);
    renderPanel();
    const cell = await openMemberEditor('Function');

    const select = required(cell.querySelector('select'), "the cell's select");
    fireEvent.change(select, { target: { value: 'HasKeyword' } });
    fireEvent.blur(select);

    expect(postedEnvelopes()).toEqual([{ op: 'set', path: dataMember('Function'), value: 'HasKeyword' }]);
  });

  it('a member that governs nothing posts the same one-leaf set', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp', Unknown3: -1,
    })]);
    renderPanel();
    const cell = await openMemberEditor('Unknown3');

    const input = required(cell.querySelector('input'), "the cell's input");
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);

    expect(postedEnvelopes()).toEqual([{ op: 'set', path: dataMember('Unknown3'), value: 7 }]);
  });
});

// Use Global is an ordinary discriminator switch: the Kind row's own set, which the backend turns
// into the leaf switch that keeps every member the two leaves share.
describe('switching a condition\'s leaf', () => {
  it('posts one set of the discriminator member with the chosen leaf\'s wire value', async () => {
    currentCompare = oneColumn([condition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();
    const element = required(screen.getAllByText('[0]').find(el => el.tagName === 'TD'), "the '[0]' index cell");
    const elementRow = required(element.closest('tr'), "the '[0]' element's row");
    fireEvent.click(required(elementRow.querySelector('button'), "the '[0]' row's expand button"));
    await waitFor(() => expect(labelCell('Kind')).toBeDefined());

    const kindLabelCell = required(labelCell('Kind'), "the 'Kind' row's label cell");
    const kindRow = required(kindLabelCell.closest('tr'), "the 'Kind' row");
    const cell = required(kindRow.querySelectorAll('td')[1], "the 'Kind' row's second cell");
    fireEvent.doubleClick(required(cell.querySelector('[data-open-trigger]'), "the cell's open trigger"));
    const select = required(cell.querySelector('select'), "the cell's select");
    fireEvent.change(select, { target: { value: 'ConditionGlobal' } });
    fireEvent.blur(select);

    expect(postedEnvelopes()).toEqual([{
      op: 'set',
      path: [{ kind: 'member', name: 'Conditions' }, { kind: 'index', index: 0 }, { kind: 'member', name: 'MutagenObjectType' }],
      value: 'ConditionGlobal',
    }]);
  });
});

// ComparisonValue's shape is the leaf's: a float under ConditionFloat, a GLOB link under
// ConditionGlobal. Each column's cell is the widget of that column's own leaf.
describe('a type-varying member takes its cell from each column\'s own leaf', () => {
  it('renders a number beside a resolved link on one row', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [condition({ ComparisonValue: 2.5 }, { Function: 'IsSneaking' })],
      'Other.esp': [condition({
        MutagenObjectType: 'ConditionGlobal', ComparisonValue: '00000ABC:MyMod.esp',
      }, { Function: 'IsSneaking' })],
    }, { '00000ABC:MyMod.esp': 'MyGlobal' });
    renderPanel();
    await expandConditions();
    const element = required(screen.getAllByText('[0]').find(el => el.tagName === 'TD'), "the '[0]' index cell");
    const elementRow = required(element.closest('tr'), "the '[0]' element's row");
    fireEvent.click(required(elementRow.querySelector('button'), "the '[0]' row's expand button"));
    await waitFor(() => expect(labelCell('ComparisonValue')).toBeDefined());

    const comparisonValueLabelCell = required(labelCell('ComparisonValue'), "the 'ComparisonValue' row's label cell");
    const comparisonValueRow = required(comparisonValueLabelCell.closest('tr'), "the 'ComparisonValue' row");
    const cells = comparisonValueRow.querySelectorAll('td');
    expect(required(cells[1], "the 'ComparisonValue' row's second cell").textContent).toBe('2.5');
    expect(required(cells[2], "the 'ComparisonValue' row's third cell").textContent).toBe('MyGlobal [00000ABC:MyMod.esp]');
  });
});

describe('the function picker comes from the schema', () => {
  it('Fallout 4 picks the function from the function member’s own enum', async () => {
    currentCompare = oneColumn([condition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await waitFor(() => screen.getByText('Conditions'));
    fireEvent.click(required(screen.getAllByText('▶')[0], "the first expand toggle"));
    await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
    const el0 = required(screen.getAllByText('[0]').find(e => e.tagName === 'TD'), "the '[0]' index cell");
    const el0Row = required(el0.closest('tr'), "the '[0]' element's row");
    fireEvent.click(required(el0Row.querySelector('button'), "the '[0]' row's expand button"));
    await waitFor(() => expect(labelCell('Data')).toBeDefined());
    const dataLabelCell = required(labelCell('Data'), "the 'Data' row's label cell");
    const dataRow = required(dataLabelCell.closest('tr'), "the 'Data' row");
    fireEvent.click(required(dataRow.querySelector('button'), "the 'Data' row's expand button"));
    await waitFor(() => expect(labelCell('Function')).toBeDefined());

    const functionLabelCell = required(labelCell('Function'), "the 'Function' row's label cell");
    const functionRow = required(functionLabelCell.closest('tr'), "the 'Function' row");
    const cell = required(functionRow.querySelectorAll('td')[1], "the 'Function' row's second cell");
    fireEvent.doubleClick(required(cell.querySelector('[data-open-trigger]'), "the cell's open trigger"));
    const select = required(cell.querySelector('select'), "the cell's select");
    const options = Array.from(select.options).map(o => o.value);
    expect(options).toEqual(Object.keys(FUNCTION_SLOTS));
  });
});

describe('a Run On label that contains spaces', () => {
  // xEdit writes the Run On prefix with its spaces stripped. No Fallout 4 enum reaches the
  // webview labelled at all, so the rule is stated against a labelled RunOnType instead.
  const labelled: FieldMetadata = {
    ...conditionsMeta,
    elementType: {
      ...conditionsElementType,
      fields: conditionsElementTypeFields.map(f => (f.name !== 'Data' ? f : {
        ...f,
        fields: required(f.fields, "the Data field's own fields").map(m => (m.name !== 'RunOnType' ? m : {
          ...m,
          enumMembers: m.enumMembers.map(e => ({ ...e, label: e.value.replace('CombatTarget', 'Combat Target') })),
        })),
      })),
    },
  };

  it('strips them, so the prefix reads as one word', async () => {
    const element = condition({}, { RunOnType: 'CombatTarget', Function: 'IsSneaking' });
    const base = oneColumn([element]);
    const baseOverride = required(base.overrides[0], "oneColumn's sole override");
    currentCompare = {
      ...base,
      overrides: [{ ...baseOverride, fields: [{ metadata: labelled, value: [element] }] }],
    };
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('CombatTarget.IsSneaking = 1.000000');
  });
});
