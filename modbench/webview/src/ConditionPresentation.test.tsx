import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import { collapsedReading, type Reading } from './presentation';
import type { CompareResult, FieldMetadata } from './types';
import { vscode } from './vscode';
import {
  compareOverride, compareResultFixture, diffNode, fieldCompared, fieldMeta, hostPickingEnum, panelClient,
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
    fieldMeta({
      name: 'RunOnType', type: 'enum',
      default: 'Subject',
      enumMembers: FALLOUT4_RUN_ON_VALUES.map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: Object.fromEntries(FALLOUT4_RUN_ON_VALUES.map(v => [v, v === 'Reference' ? ['Reference'] : []])),
    }),
    fieldMeta({ name: 'Reference', type: 'formKey' }),
    fieldMeta({ name: 'Unknown3', type: 'int' }),
    fieldMeta({
      name: 'Function', type: 'enum',
      enumMembers: Object.keys(GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED).map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED,
    }),
    fieldMeta({ name: 'ParameterOneRecord', type: 'formKey' }),
    fieldMeta({ name: 'ParameterOneNumber', type: 'int' }),
    fieldMeta({ name: 'ParameterOneString', type: 'string' }),
    fieldMeta({ name: 'ParameterTwoRecord', type: 'formKey' }),
    fieldMeta({ name: 'ParameterTwoNumber', type: 'int' }),
    fieldMeta({ name: 'ParameterTwoString', type: 'string' }),
    fieldMeta({ name: 'EventFunction', type: 'int' }),
    fieldMeta({ name: 'EventMember', type: 'int' }),
    fieldMeta({ name: 'Parameter3', type: 'formKey' }),
    fieldMeta({
      name: 'MutagenObjectType', type: 'enum',
      displayLabel: 'Kind', isDiscriminator: true,
      enumMembers: [
        { value: 'FunctionConditionData', bitValue: null, label: 'Function' },
        { value: 'GetEventData', bitValue: null, label: 'Get Event' },
      ],
    }),
  ],
});

const leafTypedComparisonValueMetaShapedAsItsFirstLeaf: FieldMetadata = fieldMeta({
  name: 'ComparisonValue', type: 'float',
  variants: { ConditionFloat: fieldMeta({ name: 'ComparisonValue', type: 'float' }), ConditionGlobal: fieldMeta({ name: 'ComparisonValue', type: 'formKey' }) },
});

const conditionsMeta = fieldMeta({
  name: 'Conditions', type: 'array', isArray: true,
  elementType: fieldMeta({
    name: '', type: 'struct',
    leafTypeName: 'Condition',
    fields: [
      dataMeta,
      fieldMeta({
        name: 'CompareOperator', type: 'enum',
        enumMembers: ['EqualTo', 'NotEqualTo', 'GreaterThan', 'GreaterThanOrEqualTo', 'LessThan', 'LessThanOrEqualTo']
          .map(value => ({ value, bitValue: null, label: null })),
      }),
      fieldMeta({
        name: 'Flags', type: 'flags',
        enumMembers: [
          { value: 'OR', bitValue: '1', label: null },
          { value: 'ParametersUseAliases', bitValue: '2', label: null },
        ],
      }),
      leafTypedComparisonValueMetaShapedAsItsFirstLeaf,
      fieldMeta({
        name: 'MutagenObjectType', type: 'enum',
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

const compareResult = (
  byColumn: Record<string, Condition[]>, resolutions: Record<string, string> = {}, meta: FieldMetadata = conditionsMeta,
): CompareResult => fieldCompared(meta, byColumn, { formKey: '000001:MyMod.esp', editorId: 'TestCobj', editorIds: resolutions });

const oneColumn = (
  elements: Condition[], resolutions: Record<string, string> = {}, meta: FieldMetadata = conditionsMeta,
) => compareResult({ [PLUGIN]: elements }, resolutions, meta);

let currentCompare: CompareResult = compareResultFixture();

function renderPanel() {
  return render(<RecordPanel client={panelClient(() => currentCompare, {
    plugins: [{ name: PLUGIN, isCompiledPlugin: true }],
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
  await waitFor(() => expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(indexCells.length));
}

const elementCells = (index: number): HTMLTableCellElement[] => Array.from(required(
  required(screen.getAllByText(`[${index}]`).find(el => el.tagName === 'TD'), `the [${index}] row cell`).closest('tr'),
  `the [${index}] row`).querySelectorAll('td'));

const summaryOf = (index: number): string => required(elementCells(index)[1], `the [${index}] row's summary cell`).textContent;

const rowLabelTdNotAValueCellOfTheSameText = (name: string): HTMLElement | undefined =>
  screen.queryAllByText(name).find(el => el.tagName === 'TD');

async function openFirstConditionData() {
  await openConditions();
  await waitFor(() => expect(rowLabelTdNotAValueCellOfTheSameText('Function')).toBeDefined());
}

async function openMemberEditor(memberName: string): Promise<HTMLTableCellElement> {
  await openFirstConditionData();
  const labelled = required(rowLabelTdNotAValueCellOfTheSameText(memberName), `the ${memberName} row label cell`);
  const cell = required(required(labelled.closest('tr'), `the ${memberName} row`).querySelectorAll('td')[1], `the ${memberName} row's value cell`);
  fireEvent.doubleClick(required(cell.querySelector('[data-open-trigger]'), `the ${memberName} value cell's open trigger`));
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

  it('a column with fewer conditions ends its list where its own last element is', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [documentSpelledCondition({}, { Function: 'IsSneaking' }), documentSpelledCondition({}, { Function: 'IsSneaking' })],
      'Other.esp': [documentSpelledCondition({}, { Function: 'IsSneaking' })],
    });
    renderPanel();
    await collapseConditions();

    expect(elementCells(0).slice(1).map(cell => cell.textContent))
      .toEqual(['Subject.IsSneaking = 1.000000 AND', 'Subject.IsSneaking = 1.000000']);
  });

  it('an expanded condition shows its members instead of the summary', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await openConditions();

    await waitFor(() => screen.getByText('Data'));
    expect(summaryOf(0)).toBe('');
  });

  it('a list of one condition reads as that condition, the last of its list', async () => {
    currentCompare = oneColumn([documentSpelledCondition({ Flags: ['OR'] }, { Function: 'IsSneaking' })]);
    renderPanel();
    await openConditions();
    const conditions = required(rowLabelTdNotAValueCellOfTheSameText('Conditions')?.closest('tr'), 'the Conditions row');
    fireEvent.click(required(conditions.querySelector('button'), 'the Conditions row toggle'));

    expect(conditions.querySelectorAll('td')[1]?.textContent).toBe('Subject.IsSneaking = 1.000000');
  });

  it('a condition that is no list\'s element joins nothing', async () => {
    const lone = documentSpelledCondition({ Flags: ['OR'] }, { Function: 'IsSneaking' });
    currentCompare = compareResultFixture({
      overrides: [compareOverride({
        formKey: '000001:MyMod.esp', plugin: PLUGIN, isWinner: true, editorId: 'TestCobj',
        fields: [{ metadata: { ...conditionsElementType, name: 'Condition' }, value: lone }],
      })],
      diffs: [diffNode({
        fieldName: 'Condition',
        values: { [PLUGIN]: lone },
        children: Object.entries(lone).map(([name, value]) => diffNode({ fieldName: name, values: { [PLUGIN]: value } })),
      })],
    });
    renderPanel();
    await waitFor(() => screen.getByText('Condition'));
    const condition = required(rowLabelTdNotAValueCellOfTheSameText('Condition')?.closest('tr'), 'the Condition row');
    fireEvent.click(required(condition.querySelector('button'), 'the Condition row toggle'));

    expect(condition.querySelectorAll('td')[1]?.textContent).toBe('Subject.IsSneaking = 1.000000');
  });
});

describe('collapsedReading of a condition', () => {
  const notAUnionWithAnEntryTheTableAlreadyHas: FieldMetadata = {
    ...conditionsMeta,
    elementType: {
      ...conditionsElementType,
      leafTypeName: 'ConditionFloat',
      fields: conditionsElementTypeFields.filter(f => !f.isDiscriminator),
    },
  };
  const declaredConcreteBase: FieldMetadata = {
    ...conditionsMeta,
    elementType: { ...conditionsElementType, leafTypeName: 'ConditionFloat' },
  };
  const withoutDiscriminator = documentSpelledCondition({}, { Function: 'IsSneaking' });
  delete withoutDiscriminator.MutagenObjectType;
  const prose = (text: string): Reading => ({ text, isPlaceholder: false });
  const playerRef = { '00000014:Fallout4.esm': 'PlayerRef' };

  const rows: {
    name: string; conditions: Condition[]; resolutions?: Record<string, string>; meta?: FieldMetadata; isLast?: boolean; reads: Reading;
  }[] = [
    { name: 'Run On = Reference reads the reference as its short name in parentheses',
      conditions: [documentSpelledCondition({}, {
        RunOnType: 'Reference', Reference: '00000014:Fallout4.esm', Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp',
      })],
      resolutions: { ...playerRef, '00AABBCC:MyMod.esp': 'ArmorKeyword' },
      reads: prose('(PlayerRef).HasKeyword(ArmorKeyword) = 1.000000') },
    { name: 'a function with no parameters is written without parentheses',
      conditions: [documentSpelledCondition({ CompareOperator: 'NotEqualTo' }, { Function: 'IsSneaking' })],
      reads: prose('Subject.IsSneaking <> 1.000000') },
    { name: 'a string parameter is written without parentheses, xEdit ignoring the slot, the value having its own row',
      conditions: [documentSpelledCondition({}, { Function: 'GetGraphVariableFloat', ParameterOneString: 'bAllowRotation' })],
      reads: prose('Subject.GetGraphVariableFloat = 1.000000') },
    { name: 'both record slots read as short names',
      conditions: [documentSpelledCondition({}, {
        Function: 'HasAssociationType', ParameterOneRecord: '00000014:Fallout4.esm', ParameterTwoRecord: '00003333:MyMod.esp',
      })],
      resolutions: { ...playerRef, '00003333:MyMod.esp': 'MyAssocType' },
      reads: prose('Subject.HasAssociationType(PlayerRef, MyAssocType) = 1.000000') },
    { name: 'a string second parameter drops only itself',
      conditions: [documentSpelledCondition({}, {
        Function: 'GetVMQuestVariable', ParameterOneRecord: '00000F1E:MyMod.esp', ParameterTwoString: '::myVar',
      })],
      resolutions: { '00000F1E:MyMod.esp': 'MyQuest' },
      reads: prose('Subject.GetVMQuestVariable(MyQuest) = 1.000000') },
    { name: 'a GLOB comparison reads as the global\'s short name, not a float',
      conditions: [documentSpelledCondition({
        MutagenObjectType: 'ConditionGlobal', CompareOperator: 'GreaterThanOrEqualTo', ComparisonValue: '00000ABC:MyMod.esp',
      }, { Function: 'IsSneaking' })],
      resolutions: { '00000ABC:MyMod.esp': 'MyGlobal' },
      reads: prose('Subject.IsSneaking >= MyGlobal') },
    { name: 'the OR flag writes OR after a non-last element',
      conditions: [documentSpelledCondition({ Flags: ['OR'] })], isLast: false,
      reads: prose('Subject.IsSneaking = 1.000000 OR') },
    { name: 'the last element of the list carries no conjunction at all',
      conditions: [documentSpelledCondition({ Flags: ['OR'] })],
      reads: prose('Subject.IsSneaking = 1.000000') },
    { name: 'the leaf with no function member of its own, as Fallout 4\'s GetEventData is one function, is named by its own leaf type',
      conditions: [documentSpelledCondition({}, { MutagenObjectType: 'GetEventData', Function: null, EventFunction: 0, EventMember: 0 })],
      reads: prose('Subject.GetEventData = 1.000000') },
    { name: 'a leaf that is not a union reads from the type name the schema declares',
      conditions: [withoutDiscriminator], meta: notAUnionWithAnEntryTheTableAlreadyHas,
      reads: prose('Subject.IsSneaking = 1.000000') },
    { name: 'a union whose own value names no leaf keys on nothing, not on the name the schema declares, which as a concrete base is a leaf name too',
      conditions: [documentSpelledCondition({ MutagenObjectType: null }, { Function: 'IsSneaking' })], meta: declaredConcreteBase,
      reads: { text: '{…}', isPlaceholder: true } },
  ];

  it.each(rows)('$name', ({ conditions, resolutions, meta = conditionsMeta, isLast = true, reads }) => {
    const [conditionDiff] = required(oneColumn(conditions, resolutions, meta).diffs[0]?.children, 'the condition rows');

    const reading = collapsedReading(required(conditionDiff, 'the condition row'), meta.elementType ?? undefined, PLUGIN, 'English', isLast);

    expect(reading).toEqual(reads);
  });
});

describe('collapsedReading of a condition whose function is its kind', () => {
  const kinds = [
    ['GetStageDoneConditionData', 'GetStageDone'], ['GetIsIDConditionData', 'GetIsID'], ['GetEventDataConditionData', 'GetEventData'],
  ];
  const own = (name: string, type: FieldMetadata['type'], kind: string, extra: Partial<FieldMetadata> = {}) =>
    fieldMeta({ name, type, allowsNull: true, variants: { [kind]: fieldMeta({ name, type, ...extra }) } });
  const kindPerFunctionData = fieldMeta({
    name: 'Data', type: 'struct', leafTypeName: 'ConditionData',
    fields: [
      fieldMeta({ name: 'RunOnType', type: 'enum', default: 'Subject', enumMembers: [{ value: 'Subject', bitValue: null, label: null }] }),
      fieldMeta({ name: 'UseAliases', type: 'bool' }),
      own('Quest', 'formKey', 'GetStageDoneConditionData', { indexWhen: ['UseAliases'] }),
      own('Stage', 'int', 'GetStageDoneConditionData'),
      own('Object', 'formKey', 'GetIsIDConditionData', { indexWhen: ['UseAliases'] }),
      own('Function', 'enum', 'GetEventDataConditionData', { enumMembers: [{ value: 'GetValue', bitValue: null, label: null }] }),
      own('VariableName', 'string', 'GetEventDataConditionData'),
      fieldMeta({
        name: 'MutagenObjectType', type: 'enum',
        displayLabel: 'Function', isDiscriminator: true,
        enumMembers: kinds.map(([value, label]) => ({ value: value ?? '', bitValue: null, label: label ?? null })),
      }),
    ],
  });
  const meta: FieldMetadata = {
    ...conditionsMeta,
    elementType: { ...conditionsElementType, fields: conditionsElementTypeFields.map(f => (f.name === 'Data' ? kindPerFunctionData : f)) },
  };
  const condition = (data: Condition): Condition => ({
    MutagenObjectType: 'ConditionFloat', CompareOperator: 'EqualTo', Flags: [], ComparisonValue: 1, Data: data,
  });
  const readingOf = (data: Condition, resolutions: Record<string, string> = {}) => {
    const [conditionDiff] = required(oneColumn([condition(data)], resolutions, meta).diffs[0]?.children, 'the condition rows');
    return collapsedReading(required(conditionDiff, 'the condition row'), meta.elementType ?? undefined, PLUGIN, 'English', true).text;
  };

  it('names the function as its kind reads, then the parameters that kind holds', () => {
    expect(readingOf({ MutagenObjectType: 'GetStageDoneConditionData', Quest: '00000F1E:MyMod.esp', Stage: 10 }, { '00000F1E:MyMod.esp': 'MyQuest' }))
      .toBe('Subject.GetStageDone(MyQuest, 10) = 1.000000');
  });

  it('reads a parameter that names an alias as its number', () => {
    expect(readingOf({ MutagenObjectType: 'GetIsIDConditionData', UseAliases: true, Object: 3 })).toBe('Subject.GetIsID(3) = 1.000000');
  });

  it('reads a kind\'s own Function member as a parameter, leaving out a string', () => {
    expect(readingOf({ MutagenObjectType: 'GetEventDataConditionData', Function: 'GetValue', VariableName: 'x' }))
      .toBe('Subject.GetEventData(GetValue) = 1.000000');
  });
});

describe('a condition shows one row per parameter slot in use', () => {
  const dataRowLabels = () => {
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const labels = rows.map(tr => tr.querySelector('td')?.textContent);
    return labels.slice(labels.indexOf('Data') + 1, labels.indexOf('CompareOperator'));
  };

  it.each([
    ['a record-slot function renders ParameterOneRecord and neither of its aliases',
      { Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp', ParameterOneNumber: 0, ParameterOneString: '' },
      ['RunOnType', 'Unknown3', 'Function', 'ParameterOneRecord', 'Kind']],
    ['a number-slot function renders ParameterOneNumber and not the record twin sharing its four bytes',
      { Function: 'GetVATSValue', ParameterOneNumber: 10, ParameterTwoNumber: 0, ParameterOneRecord: '00000000:Null', ParameterTwoRecord: '00000000:Null' },
      ['RunOnType', 'Unknown3', 'Function', 'ParameterOneNumber', 'ParameterTwoNumber', 'Kind']],
    ['Parameter #3 is written whatever the function is, so it is never hidden', { Function: 'IsSneaking' }, ['RunOnType', 'Unknown3', 'Function', 'Kind']],
    ['the reference row appears only under Run On = Reference', { Function: 'IsSneaking', Reference: '00000000:Null' },
      ['RunOnType', 'Unknown3', 'Function', 'Kind']],
  ])('%s', async (_case, data, rows) => {
    currentCompare = oneColumn([documentSpelledCondition({}, data)]);
    renderPanel();
    await openFirstConditionData();

    expect(dataRowLabels()).toEqual(rows);
  });
});

describe('a governing member posts its own value and nothing else, the cascade being the writer\'s: the backend clears the slots the new value idles from the document it holds', () => {
  it('changing Run On away from Reference posts one set of Run On', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
      RunOnType: 'Reference', Reference: '00000014:Fallout4.esm', Function: 'IsSneaking',
    })]);
    renderPanel();
    vi.mocked(vscode.postMessage).mockImplementation(hostPickingEnum(() => 'Subject'));
    await openMemberEditor('RunOnType');

    await waitFor(() => expect(postedEnvelopes()).toEqual([{ op: 'set', path: dataMember('RunOnType'), value: 'Subject' }]));
  });

  it('changing the function posts one set of the function, no emptied slots beside it', async () => {
    currentCompare = oneColumn([documentSpelledCondition({}, {
      Function: 'GetGraphVariableFloat', ParameterOneString: 'bAllowRotation',
    })]);
    renderPanel();
    vi.mocked(vscode.postMessage).mockImplementation(hostPickingEnum(() => 'HasKeyword'));
    await openMemberEditor('Function');

    await waitFor(() => expect(postedEnvelopes()).toEqual([{ op: 'set', path: dataMember('Function'), value: 'HasKeyword' }]));
  });

});

describe('a type-varying member takes its cell from each column\'s own leaf: ComparisonValue is a float under ConditionFloat, a GLOB link under ConditionGlobal', () => {
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
    expect(required(cells[2], "the 'ComparisonValue' row's third cell").textContent).toBe('MyGlobal');
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
    let offered: string[] = [];
    vi.mocked(vscode.postMessage).mockImplementation(hostPickingEnum((choices) => {
      offered = choices.map(c => c.value);
      return null;
    }));
    fireEvent.doubleClick(required(cell.querySelector('[data-open-trigger]'), "the cell's open trigger"));

    expect(offered).toEqual(Object.keys(GET_PARAMETER_TYPES_SLOTS_OF_THE_FUNCTIONS_USED).sort());
  });
});

describe('a Run On label that contains spaces, which xEdit writes as the Run On prefix with its spaces stripped', () => {
  const labelledRunOnTypeAsNoFallout4EnumReachesTheWebviewLabelled: FieldMetadata = {
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
      overrides: [{ ...baseOverride, fields: [{ metadata: labelledRunOnTypeAsNoFallout4EnumReachesTheWebviewLabelled, value: [element] }] }],
    };
    renderPanel();
    await collapseConditions();

    expect(summaryOf(0)).toBe('CombatTarget.IsSneaking = 1.000000');
  });
});
