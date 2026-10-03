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

const FALLOUT4_RUN_ON_VALUES = ['Subject', 'Target', 'Reference', 'CombatTarget'];

const GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED: Record<string, string[]> = {
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
      enumMembers: FALLOUT4_RUN_ON_VALUES.map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: Object.fromEntries(FALLOUT4_RUN_ON_VALUES.map(v => [v, v === 'Reference' ? ['Reference'] : []])),
    }),
    leaf('Reference', 'formKey'),
    leaf('Unknown3', 'int'),
    leaf('Function', 'enum', {
      enumMembers: Object.keys(GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED).map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED,
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

const leafTypedComparisonValueMeta: FieldMetadata = leaf('ComparisonValue', 'float', {
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
      leafTypedComparisonValueMeta,
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

const conditionsElementType = required(conditionsMeta.elementType, "conditionsMeta's elementType");
const conditionsElementTypeFields = required(conditionsElementType.fields, "conditionsMeta's elementType fields");

type Condition = Record<string, unknown>;

function reflectedPropertyOf(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

const documentSpelledCondition = (over: Condition = {}, data: Condition = {}): Condition => ({
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

function compareResult(
  byColumn: Record<string, Condition[]>, resolutions: Record<string, string> = {},
  meta: FieldMetadata = conditionsMeta,
): CompareResult {
  const columns = Object.keys(byColumn);
  const at = (column: string, index: number, path: string[]): unknown => {
    const rows = byColumn[column];
    if (!rows) throw new Error(`compareResult: no rows recorded for column "${column}"`);
    return path.reduce<unknown>((v, name) => reflectedPropertyOf(v, name), rows[index]);
  };

  const resolutionsFor = (path: string[], index: number) => {
    const resolutionEntriesAsTuples = columns
      .map(c => [c, at(c, index, path)] as const)
      .filter(([, v]) => typeof v === 'string' && resolutions[v])
      .map(([c, v]): [string, { state: 'ResolvedValidType'; recordType: null; editorId: string | undefined }] =>
        [c, { state: 'ResolvedValidType', recordType: null, editorId: resolutions[String(v)] }]);
    return resolutionEntriesAsTuples.length > 0 ? Object.fromEntries(resolutionEntriesAsTuples) : undefined;
  };

  const valuesFor = (path: string[], index: number) =>
    Object.fromEntries(columns.map(c => [c, at(c, index, path) ?? null]));

  const memberDiffsOfEveryMemberSomeColumnCarries = (path: string[], index: number): FieldDiff[] => {
    const keys = [...new Set(columns.flatMap(c => {
      const value = at(c, index, path);
      return Object.keys(typeof value === 'object' && value !== null ? value : {});
    }))];
    return keys.map(name => diffNode({
      fieldName: name,
      values: valuesFor([...path, name], index),
      winnerColumn: columns[0], cellStates: {},
      resolutions: resolutionsFor([...path, name], index),
      children: name === 'Data' ? memberDiffsOfEveryMemberSomeColumnCarries([...path, name], index) : undefined,
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
      isWinner: i === 0, editorId: 'TestCobj',
      fields: [{ metadata: meta, value: byColumn[plugin] }], conflictThis: 'Master',
    })),
    diffs: [diffNode({
      fieldName: 'Conditions',
      values: Object.fromEntries(columns.map(c => [c, byColumn[c]])),
      winnerColumn: columns[0], cellStates: {},
      children: firstColumnRows.map((_, i) => diffNode({
        fieldName: `[${i}]`,
        values: valuesFor([], i),
        indexes: Object.fromEntries(columns.filter(c => i < (byColumn[c]?.length ?? 0)).map(c => [c, i])),
        winnerColumn: columns[0], cellStates: {},
        children: memberDiffsOfEveryMemberSomeColumnCarries([], i),
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

async function openConditions() {
  await waitFor(() => screen.getByText('Conditions'));
  await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
}

async function collapseConditions() {
  await openConditions();
  const indexCells = screen.getAllByText(/^\[\d+\]$/).filter(el => el.tagName === 'TD');
  for (const cell of indexCells) {
    const toggle = required(cell.closest('tr')?.querySelector('button'), 'the element row toggle');
    fireEvent.click(toggle);
  }
  await waitFor(() => expect(screen.getAllByText('▶')).toHaveLength(indexCells.length));
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

const rowLabelTdNotAValueCellOfTheSameText = (name: string): HTMLElement | undefined =>
  screen.queryAllByText(name).find(el => el.tagName === 'TD');

async function openFirstConditionData() {
  await openConditions();
  await waitFor(() => expect(rowLabelTdNotAValueCellOfTheSameText('Function')).toBeDefined());
}

async function openMemberEditor(memberName: string): Promise<HTMLTableCellElement> {
  await openFirstConditionData();
  const labelled = rowLabelTdNotAValueCellOfTheSameText(memberName);
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
        documentSpelledCondition({}, {
          RunOnType: 'CombatTarget', Function: 'GetStageDone',
          ParameterOneRecord: '00123456:MyMod.esp', ParameterTwoNumber: 10,
        }),
        documentSpelledCondition(),
      ],
      { '00123456:MyMod.esp': 'MQ101' },
    );
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('CombatTarget.GetStageDone(MQ101, 10) = 1.000000 AND');
  });

  it('Run On = Reference renders the reference as its short name in parentheses', async () => {
    currentCompare = oneColumn(
      [documentSpelledCondition({}, {
        RunOnType: 'Reference', Reference: '00000014:Fallout4.esm',
        Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp',
      })],
      { '00000014:Fallout4.esm': 'PlayerRef', '00AABBCC:MyMod.esp': 'ArmorKeyword' },
    );
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('(PlayerRef).HasKeyword(ArmorKeyword) = 1.000000');
  });

  it('a function with no parameters is written without parentheses', async () => {
    currentCompare = oneColumn([documentSpelledCondition({ CompareOperator: 'NotEqualTo' }, { Function: 'IsSneaking' })]);
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking <> 1.000000');
  });

  it('a string parameter is written without parentheses — xEdit ignores the slot, the value has its own row', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
      Function: 'GetGraphVariableFloat', ParameterOneString: 'bAllowRotation',
    })]);
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.GetGraphVariableFloat = 1.000000');
  });

  it('both record slots read as short names', async () => {
    currentCompare = oneColumn(
      [documentSpelledCondition({}, {
        Function: 'HasAssociationType',
        ParameterOneRecord: '00000014:Fallout4.esm', ParameterTwoRecord: '00003333:MyMod.esp',
      })],
      { '00000014:Fallout4.esm': 'PlayerRef', '00003333:MyMod.esp': 'MyAssocType' },
    );
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.HasAssociationType(PlayerRef, MyAssocType) = 1.000000');
  });

  it('a string second parameter drops only itself', async () => {
    currentCompare = oneColumn(
      [documentSpelledCondition({}, {
        Function: 'GetVMQuestVariable',
        ParameterOneRecord: '00000F1E:MyMod.esp', ParameterTwoString: '::myVar',
      })],
      { '00000F1E:MyMod.esp': 'MyQuest' },
    );
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.GetVMQuestVariable(MyQuest) = 1.000000');
  });

  it('a GLOB comparison reads as the global’s short name, not a float', async () => {
    currentCompare = oneColumn(
      [documentSpelledCondition({
        MutagenObjectType: 'ConditionGlobal', CompareOperator: 'GreaterThanOrEqualTo',
        ComparisonValue: '00000ABC:MyMod.esp',
      }, { Function: 'IsSneaking' })],
      { '00000ABC:MyMod.esp': 'MyGlobal' },
    );
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking >= MyGlobal');
  });

  it('the OR flag writes OR, and the last element of the list carries no conjunction at all', async () => {
    currentCompare = oneColumn([
      documentSpelledCondition({ Flags: ['OR'] }, { Function: 'IsSneaking' }),
      documentSpelledCondition({ Flags: ['OR'] }, { Function: 'IsSneaking' }),
    ]);
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking = 1.000000 OR');
    expect(summaryOf(1)).toBe('Subject.IsSneaking = 1.000000');
  });

  it('a column with fewer conditions ends its list where its own last element is', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [documentSpelledCondition({}, { Function: 'IsSneaking' }), documentSpelledCondition({}, { Function: 'IsSneaking' })],
      'Other.esp': [documentSpelledCondition({}, { Function: 'IsSneaking' })],
    });
    renderPanel();
    await collapseConditions();

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

  it('the leaf with no function member of its own, as Fallout 4\'s GetEventData *is* one function, is named by its own leaf type', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
      MutagenObjectType: 'GetEventData', Function: null, EventFunction: 0, EventMember: 0,
    })]);
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.GetEventData = 1.000000');
  });

  it('an expanded condition shows its members instead of the summary', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await openConditions();

    await waitFor(() => screen.getByText('Data'));
    expect(summaryOf(0)).toBe('');
  });
});

describe('the table keys on the leaf type name: the discriminator\'s value where the leaf is a union, the schema\'s declared type name where it is not', () => {
  const notAUnionWithAnEntryTheTableAlreadyHas: FieldMetadata = {
    ...conditionsMeta,
    elementType: {
      ...conditionsElementType,
      leafTypeName: 'ConditionFloat',
      fields: conditionsElementTypeFields.filter(f => !f.isDiscriminator),
    },
  };

  it('reads its summary from the type name the schema declares', async () => {
    const noDiscriminator = documentSpelledCondition({}, { Function: 'IsSneaking' });
    delete noDiscriminator.MutagenObjectType;
    currentCompare = oneColumn([noDiscriminator], {}, notAUnionWithAnEntryTheTableAlreadyHas);
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking = 1.000000');
  });

  it('a union whose own value names no leaf keys on nothing, not on the name the schema declares, which as a concrete base is a leaf name too',async () => {
    const declared: FieldMetadata = {
      ...conditionsMeta,
      elementType: { ...conditionsElementType, leafTypeName: 'ConditionFloat' },
    };
    const unnamed = documentSpelledCondition({ MutagenObjectType: null }, { Function: 'IsSneaking' });
    currentCompare = oneColumn([unnamed], {}, declared);
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('{…}');
  });
});

describe('a condition shows one row per parameter slot in use', () => {
  it('a record-slot function renders ParameterOneRecord and neither of its aliases', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
      Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp',
    })]);
    renderPanel();
    await openFirstConditionData();

    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneRecord')).toBeDefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneNumber')).toBeUndefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneString')).toBeUndefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterTwoRecord')).toBeUndefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterTwoNumber')).toBeUndefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterTwoString')).toBeUndefined();
  });

  it('a number-slot function renders ParameterOneNumber and not the record twin sharing its four bytes', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
      Function: 'GetVATSValue', ParameterOneNumber: 10, ParameterTwoNumber: 0,
    })]);
    renderPanel();
    await openFirstConditionData();

    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneNumber')).toBeDefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterTwoNumber')).toBeDefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneRecord')).toBeUndefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterTwoRecord')).toBeUndefined();
  });

  it('Parameter #3 is written whatever the function is, so it is never hidden', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await openFirstConditionData();

    expect(rowLabelTdNotAValueCellOfTheSameText('Unknown3')).toBeDefined();
  });

  it('the reference row appears only under Run On = Reference', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await openFirstConditionData();

    expect(rowLabelTdNotAValueCellOfTheSameText('Reference')).toBeUndefined();
  });

  it('a slot any column uses is shown, so a conflicting override never hides its own data', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [documentSpelledCondition({}, { Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp' })],
      'Other.esp': [documentSpelledCondition({}, { Function: 'GetVATSValue', ParameterOneNumber: 3 })],
    });
    renderPanel();
    await openFirstConditionData();

    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneRecord')).toBeDefined();
    expect(rowLabelTdNotAValueCellOfTheSameText('ParameterOneNumber')).toBeDefined();
  });
});

describe('a governing member posts its own value and nothing else, the cascade being the writer\'s: the backend clears the slots the new value idles from the document it holds',() => {
  it('changing Run On away from Reference posts one set of Run On', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
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
    currentCompare = oneColumn([documentSpelledCondition({}, {
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
    currentCompare = oneColumn([documentSpelledCondition({}, {
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

describe('switching a condition\'s leaf, as Use Global is an ordinary discriminator switch: the Kind row\'s own set, which the backend turns into the leaf switch that keeps every member the two leaves share',() => {
  it('posts one set of the discriminator member with the chosen leaf\'s wire value', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await openConditions();
    await waitFor(() => expect(rowLabelTdNotAValueCellOfTheSameText('Kind')).toBeDefined());

    const kindLabelCell = required(rowLabelTdNotAValueCellOfTheSameText('Kind'), "the 'Kind' row's label cell");
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

describe('a type-varying member takes its cell from each column\'s own leaf: ComparisonValue is a float under ConditionFloat, a GLOB link under ConditionGlobal',() => {
  it('renders a number beside a resolved link on one row', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [documentSpelledCondition({ ComparisonValue: 2.5 }, { Function: 'IsSneaking' })],
      'Other.esp': [documentSpelledCondition({
        MutagenObjectType: 'ConditionGlobal', ComparisonValue: '00000ABC:MyMod.esp',
      }, { Function: 'IsSneaking' })],
    }, { '00000ABC:MyMod.esp': 'MyGlobal' });
    renderPanel();
    await openConditions();
    await waitFor(() => expect(rowLabelTdNotAValueCellOfTheSameText('ComparisonValue')).toBeDefined());

    const comparisonValueLabelCell = required(rowLabelTdNotAValueCellOfTheSameText('ComparisonValue'), "the 'ComparisonValue' row's label cell");
    const comparisonValueRow = required(comparisonValueLabelCell.closest('tr'), "the 'ComparisonValue' row");
    const cells = comparisonValueRow.querySelectorAll('td');
    expect(required(cells[1], "the 'ComparisonValue' row's second cell").textContent).toBe('2.5');
    expect(required(cells[2], "the 'ComparisonValue' row's third cell").textContent).toBe('MyGlobal [00000ABC:MyMod.esp]');
  });
});

describe('the function picker comes from the schema', () => {
  it('Fallout 4 picks the function from the function member’s own enum', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await openFirstConditionData();

    const functionLabelCell = required(rowLabelTdNotAValueCellOfTheSameText('Function'), "the 'Function' row's label cell");
    const functionRow = required(functionLabelCell.closest('tr'), "the 'Function' row");
    const cell = required(functionRow.querySelectorAll('td')[1], "the 'Function' row's second cell");
    fireEvent.doubleClick(required(cell.querySelector('[data-open-trigger]'), "the cell's open trigger"));
    const select = required(cell.querySelector('select'), "the cell's select");
    const options = Array.from(select.options).map(o => o.value);
    expect(options).toEqual(Object.keys(GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED));
  });
});

describe('a Run On label that contains spaces, which xEdit writes as the Run On prefix with its spaces stripped', () => {
  const labelledRunOnType: FieldMetadata = {
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
    const element = documentSpelledCondition({}, { RunOnType: 'CombatTarget', Function: 'IsSneaking' });
    const base = oneColumn([element]);
    const baseOverride = required(base.overrides[0], "oneColumn's sole override");
    currentCompare = {
      ...base,
      overrides: [{ ...baseOverride, fields: [{ metadata: labelledRunOnType, value: [element] }] }],
    };
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('CombatTarget.IsSneaking = 1.000000');
  });
});
