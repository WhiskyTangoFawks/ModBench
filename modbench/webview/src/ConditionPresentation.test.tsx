import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';

// The metadata below is the Fallout 4 schema's own shape, trimmed to the enum members these
// cases name and never restructured; `siblingsInUse` rows come from Condition.GetParameterTypes.

const leaf = (name: string, type: string, extra: Partial<FieldMetadata> = {}): FieldMetadata =>
  ({ name, type: type as FieldMetadata['type'], isArray: false, validFormKeyTypes: [], enumMembers: [], ...extra });

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

const dataMeta: FieldMetadata = {
  name: 'Data', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
  leafTypeName: 'ConditionData',
  fields: [
    leaf('RunOnType', 'enum', {
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
};

// ComparisonValue is one member whose type the leaf decides; the variant per leaf is what the
// backend's schema carries, and the field's own shape is the first leaf's.
const comparisonValueMeta: FieldMetadata = leaf('ComparisonValue', 'float', {
  variants: { ConditionFloat: leaf('ComparisonValue', 'float'), ConditionGlobal: leaf('ComparisonValue', 'formKey') },
});

const conditionsMeta: FieldMetadata = {
  name: 'Conditions', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
  elementType: {
    name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
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
  },
};

type Condition = Record<string, unknown>;

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
) {
  const columns = Object.keys(byColumn);
  const at = (column: string, index: number, path: string[]): unknown =>
    path.reduce<unknown>((v, name) => (v as Condition | undefined)?.[name], byColumn[column][index]);

  const resolutionsFor = (path: string[], index: number) => {
    const entries = columns
      .map(c => [c, at(c, index, path)] as const)
      .filter(([, v]) => typeof v === 'string' && resolutions[v])
      .map(([c, v]) => [c, { state: 'ResolvedValidType', recordType: null, editorId: resolutions[v as string] }]);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  const valuesFor = (path: string[], index: number) =>
    Object.fromEntries(columns.map(c => [c, at(c, index, path) ?? null]));

  // A row exists for any member some column carries, as the backend's classifier aligns them; a
  // document omits a member at its default, so the keys are the union across columns.
  const memberDiffs = (path: string[], index: number): unknown[] => {
    const keys = [...new Set(columns.flatMap(c => Object.keys((at(c, index, path) as Condition | undefined) ?? {})))];
    return keys.map(name => ({
      fieldName: name,
      values: valuesFor([...path, name], index),
      winnerColumn: columns[0], winnerValue: at(columns[0], index, [...path, name]), cellStates: {},
      resolutions: resolutionsFor([...path, name], index),
      children: name === 'Data' ? memberDiffs([...path, name], index) : undefined,
    }));
  };

  return {
    conflictAll: 'NoConflict',
    overrides: columns.map((plugin, i) => ({
      formKey: '000001:MyMod.esp', plugin, origin: 'Data',
      loadOrderIndex: i + 1, isWinner: i === 0, editorId: 'TestCobj',
      fields: [{ metadata: meta, value: byColumn[plugin] }], conflictThis: 'Master',
    })),
    diffs: [{
      fieldName: 'Conditions',
      values: Object.fromEntries(columns.map(c => [c, byColumn[c]])),
      winnerColumn: columns[0], winnerValue: byColumn[columns[0]], cellStates: {},
      children: byColumn[columns[0]].map((_, i) => ({
        fieldName: `[${i}]`,
        values: valuesFor([], i),
        winnerColumn: columns[0], winnerValue: byColumn[columns[0]][i], cellStates: {},
        children: memberDiffs([], i),
      })),
    }],
  };
}

const oneColumn = (
  elements: Condition[], resolutions: Record<string, string> = {}, meta: FieldMetadata = conditionsMeta,
) => compareResult({ [PLUGIN]: elements }, resolutions, meta);

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

async function expandConditions() {
  await waitFor(() => screen.getByText('Conditions'));
  fireEvent.click(screen.getAllByText('▶')[0]);
  await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
}

function summaryOf(index: number): string {
  const td = screen.getAllByText(`[${index}]`).find(el => el.tagName === 'TD')!;
  const cells = Array.from(td.closest('tr')!.querySelectorAll('td'));
  return cells[1].textContent;
}

// A row's label cell: the member's own name, which a value cell can also read as (the Kind row
// of a FunctionConditionData reads "Function").
const labelCell = (name: string): HTMLElement | undefined =>
  screen.queryAllByText(name).find(el => el.tagName === 'TD');

async function expandFirstConditionData() {
  await expandConditions();
  const element = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!;
  fireEvent.click(element.closest('tr')!.querySelector('button')!);
  await waitFor(() => expect(labelCell('Data')).toBeDefined());
  fireEvent.click(labelCell('Data')!.closest('tr')!.querySelector('button')!);
  await waitFor(() => expect(labelCell('Function')).toBeDefined());
}

async function openMemberEditor(memberName: string): Promise<HTMLTableCellElement> {
  await expandFirstConditionData();
  const cell = labelCell(memberName)!.closest('tr')!.querySelectorAll('td')[1];
  fireEvent.doubleClick(cell.querySelector('[data-open-trigger]')!);
  return cell;
}

function lastEditField(): { fieldPath?: string; value?: unknown } | undefined {
  const calls = (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls;
  const call = [...calls].reverse().find(([m]) => (m as { type?: string }).type === WEBVIEW_TO_EXTENSION.EDIT_FIELD);
  return call?.[0] as { fieldPath?: string; value?: unknown } | undefined;
}

beforeEach(() => {
  vi.stubGlobal('mEditFormKey', '000001:MyMod.esp');
  (vscode.postMessage as ReturnType<typeof vi.fn>).mockClear();
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
    fireEvent.click(screen.getAllByText('▶')[0]);

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
      ...conditionsMeta.elementType!,
      leafTypeName: 'ConditionFloat',
      fields: conditionsMeta.elementType!.fields!.filter(f => !f.isDiscriminator),
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
      elementType: { ...conditionsMeta.elementType!, leafTypeName: 'ConditionFloat' },
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

describe('a governing member clears the siblings its new value idles', () => {
  it('changing Run On away from Reference posts an edit with the reference cleared', async () => {
    currentCompare = oneColumn([condition({}, {
      RunOnType: 'Reference', Reference: '00000014:Fallout4.esm', Function: 'IsSneaking',
    })]);
    renderPanel();
    const cell = await openMemberEditor('RunOnType');

    const select = cell.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'Subject' } });
    fireEvent.blur(select);

    const posted = lastEditField();
    expect(posted?.fieldPath).toBe('Conditions');
    const data = (posted?.value as Record<string, unknown>[])[0].Data as Record<string, unknown>;
    expect(data.RunOnType).toBe('Subject');
    expect(data.Reference).toBeNull();
  });

  it('changing the function posts an edit with every slot the new function does not use cleared', async () => {
    // ConditionBinaryWriteTranslation.CustomStringExports writes a CIS1/CIS2 subrecord for any
    // non-null parameter string without consulting the function, so a stale string reaches the
    // plugin.
    currentCompare = oneColumn([condition({}, {
      Function: 'GetGraphVariableFloat', ParameterOneString: 'bAllowRotation',
    })]);
    renderPanel();
    const cell = await openMemberEditor('Function');

    const select = cell.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'HasKeyword' } });
    fireEvent.blur(select);

    const posted = lastEditField();
    const data = (posted?.value as Record<string, unknown>[])[0].Data as Record<string, unknown>;
    expect(data.Function).toBe('HasKeyword');
    // A JSON null into ParameterOneNumber — a non-nullable Int32 — is rejected by the write path,
    // and a rejected member fails the whole array write, so each slot empties per its own type.
    expect(data.ParameterOneString).toBeNull();
    expect(data.ParameterTwoRecord).toBeNull();
    expect(data.ParameterTwoString).toBeNull();
    expect(data.ParameterOneNumber).toBe(0);
    expect(data.ParameterTwoNumber).toBe(0);
  });

  it('a member the new value still uses keeps its value', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp',
    })]);
    renderPanel();
    const cell = await openMemberEditor('Function');

    const select = cell.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'GetVMQuestVariable' } });
    fireEvent.blur(select);

    const data = (lastEditField()?.value as Record<string, unknown>[])[0].Data as Record<string, unknown>;
    expect(data.ParameterOneRecord).toBe('00AABBCC:MyMod.esp');
  });

  it('an edit to a member that governs nothing leaves its siblings alone', async () => {
    currentCompare = oneColumn([condition({}, {
      Function: 'HasKeyword', ParameterOneRecord: '00AABBCC:MyMod.esp', Unknown3: -1,
    })]);
    renderPanel();
    const cell = await openMemberEditor('Unknown3');

    const input = cell.querySelector('input')!;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);

    const data = (lastEditField()?.value as Record<string, unknown>[])[0].Data as Record<string, unknown>;
    expect(data.Unknown3).toBe(7);
    expect(data.ParameterOneRecord).toBe('00AABBCC:MyMod.esp');
  });
});

describe('the function picker comes from the schema', () => {
  it('Fallout 4 picks the function from the function member’s own enum', async () => {
    currentCompare = oneColumn([condition({}, { Function: 'IsSneaking' })]);
    renderPanel();
    await waitFor(() => screen.getByText('Conditions'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
    const el0 = screen.getAllByText('[0]').find(e => e.tagName === 'TD')!;
    fireEvent.click(el0.closest('tr')!.querySelector('button')!);
    await waitFor(() => expect(labelCell('Data')).toBeDefined());
    fireEvent.click(labelCell('Data')!.closest('tr')!.querySelector('button')!);
    await waitFor(() => expect(labelCell('Function')).toBeDefined());

    const cell = labelCell('Function')!.closest('tr')!.querySelectorAll('td')[1];
    fireEvent.doubleClick(cell.querySelector('[data-open-trigger]')!);
    const options = Array.from(cell.querySelector('select')!.options).map(o => o.value);
    expect(options).toEqual(Object.keys(FUNCTION_SLOTS));
  });
});

describe('a Run On label that contains spaces', () => {
  // xEdit writes the Run On prefix with its spaces stripped. No Fallout 4 enum reaches the
  // webview labelled at all, so the rule is stated against a labelled RunOnType instead.
  const labelled: FieldMetadata = {
    ...conditionsMeta,
    elementType: {
      ...conditionsMeta.elementType!,
      fields: conditionsMeta.elementType!.fields!.map(f => (f.name !== 'Data' ? f : {
        ...f,
        fields: f.fields!.map(m => (m.name !== 'RunOnType' ? m : {
          ...m,
          enumMembers: m.enumMembers.map(e => ({ ...e, label: e.value.replace('CombatTarget', 'Combat Target') })),
        })),
      })),
    },
  };

  it('strips them, so the prefix reads as one word', async () => {
    const element = condition({}, { RunOnType: 'CombatTarget', Function: 'IsSneaking' });
    const base = oneColumn([element]);
    currentCompare = {
      ...base,
      overrides: [{ ...base.overrides[0], fields: [{ metadata: labelled, value: [element] }] }],
    };
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('CombatTarget.IsSneaking = 1.000000');
  });
});
