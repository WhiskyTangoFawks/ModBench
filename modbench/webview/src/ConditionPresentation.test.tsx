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
  GetStageDone: ['parameter_one_record', 'parameter_two_number'],
  HasKeyword: ['parameter_one_record'],
  GetVATSValue: ['parameter_one_number', 'parameter_two_number'],
  IsSneaking: [],
  GetGraphVariableFloat: ['parameter_one_string'],
  GetVMQuestVariable: ['parameter_one_record', 'parameter_two_string'],
  HasAssociationType: ['parameter_one_record', 'parameter_two_record'],
};

const dataMeta: FieldMetadata = {
  name: 'data', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
  leafTypeName: 'ConditionData',
  fields: [
    leaf('run_on_type', 'enum', {
      enumMembers: RUN_ON_VALUES.map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: Object.fromEntries(RUN_ON_VALUES.map(v => [v, v === 'Reference' ? ['reference'] : []])),
    }),
    leaf('reference', 'formKey'),
    leaf('unknown3', 'int'),
    leaf('function', 'enum', {
      enumMembers: Object.keys(FUNCTION_SLOTS).map(value => ({ value, bitValue: null, label: null })),
      siblingsInUse: FUNCTION_SLOTS,
    }),
    leaf('parameter_one_record', 'formKey'),
    leaf('parameter_one_number', 'int'),
    leaf('parameter_one_string', 'string'),
    leaf('parameter_two_record', 'formKey'),
    leaf('parameter_two_number', 'int'),
    leaf('parameter_two_string', 'string'),
    leaf('event_function', 'int'),
    leaf('event_member', 'int'),
    leaf('parameter3', 'formKey'),
    leaf('concrete_type', 'enum', {
      displayLabel: 'Kind', isDiscriminator: true,
      enumMembers: [
        { value: 'FunctionConditionData', bitValue: null, label: 'Function' },
        { value: 'GetEventData', bitValue: null, label: 'Get Event' },
      ],
    }),
  ],
};

const conditionsMeta: FieldMetadata = {
  name: 'conditions', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
  elementType: {
    name: '', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
    leafTypeName: 'Condition',
    fields: [
      dataMeta,
      leaf('compare_operator', 'enum', {
        enumMembers: ['EqualTo', 'NotEqualTo', 'GreaterThan', 'GreaterThanOrEqualTo', 'LessThan', 'LessThanOrEqualTo']
          .map(value => ({ value, bitValue: null, label: null })),
      }),
      leaf('flags', 'enum', {
        enumMembers: [
          { value: 'OR', bitValue: '1', label: null },
          { value: 'ParametersUseAliases', bitValue: '2', label: null },
        ],
      }),
      leaf('comparison_value_float', 'float'),
      leaf('comparison_value_form_key', 'formKey'),
      leaf('concrete_type', 'enum', {
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

const condition = (over: Condition = {}, data: Condition = {}): Condition => ({
  concrete_type: 'ConditionFloat',
  compare_operator: 'EqualTo',
  flags: 0,
  comparison_value_float: 1,
  comparison_value_form_key: null,
  data: {
    concrete_type: 'FunctionConditionData',
    run_on_type: 'Subject',
    reference: null,
    unknown3: -1,
    function: 'IsSneaking',
    parameter_one_record: null,
    parameter_one_number: null,
    parameter_one_string: null,
    parameter_two_record: null,
    parameter_two_number: null,
    parameter_two_string: null,
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

  const memberDiffs = (path: string[], index: number): unknown[] => {
    const shape = at(columns[0], index, path) as Condition;
    return Object.keys(shape).map(name => ({
      fieldName: name,
      values: valuesFor([...path, name], index),
      winnerColumn: columns[0], winnerValue: at(columns[0], index, [...path, name]), cellStates: {},
      resolutions: resolutionsFor([...path, name], index),
      children: name === 'data' ? memberDiffs([...path, name], index) : undefined,
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
      fieldName: 'conditions',
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
  await waitFor(() => screen.getByText('conditions'));
  fireEvent.click(screen.getAllByText('▶')[0]);
  await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
}

function summaryOf(index: number): string {
  const td = screen.getAllByText(`[${index}]`).find(el => el.tagName === 'TD')!;
  const cells = Array.from(td.closest('tr')!.querySelectorAll('td'));
  return cells[1].textContent ?? '';
}

async function expandFirstConditionData() {
  await expandConditions();
  const element = screen.getAllByText('[0]').find(el => el.tagName === 'TD')!;
  fireEvent.click(element.closest('tr')!.querySelector('button')!);
  await waitFor(() => screen.getByText('data'));
  fireEvent.click(screen.getByText('data').closest('tr')!.querySelector('button')!);
  await waitFor(() => screen.getByText('function'));
}

async function openMemberEditor(memberName: string): Promise<HTMLTableCellElement> {
  await expandFirstConditionData();
  const cell = screen.getByText(memberName).closest('tr')!.querySelectorAll('td')[1];
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

describe('#693 — a collapsed condition reads as xEdit prose', () => {
  it('run on, function, both parameter slots, operator, float to six places, and the AND that follows a non-last element', async () => {
    currentCompare = oneColumn(
      [
        condition({ comparison_value_float: 1 }, {
          run_on_type: 'CombatTarget', function: 'GetStageDone',
          parameter_one_record: '00123456:MyMod.esp', parameter_two_number: 10,
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
        run_on_type: 'Reference', reference: '00000014:Fallout4.esm',
        function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp',
      })],
      { '00000014:Fallout4.esm': 'PlayerRef', '00AABBCC:MyMod.esp': 'ArmorKeyword' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('(PlayerRef).HasKeyword(ArmorKeyword) = 1.000000');
  });

  it('a function with no parameters is written without parentheses', async () => {
    currentCompare = oneColumn([condition({ compare_operator: 'NotEqualTo' }, { function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking <> 1.000000');
  });

  it('a string parameter is written without parentheses — xEdit ignores the slot, the value has its own row', async () => {
    currentCompare = oneColumn([condition({}, {
      function: 'GetGraphVariableFloat', parameter_one_string: 'bAllowRotation',
    })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.GetGraphVariableFloat = 1.000000');
  });

  it('both record slots read as short names', async () => {
    currentCompare = oneColumn(
      [condition({}, {
        function: 'HasAssociationType',
        parameter_one_record: '00000014:Fallout4.esm', parameter_two_record: '00003333:MyMod.esp',
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
        function: 'GetVMQuestVariable',
        parameter_one_record: '00000F1E:MyMod.esp', parameter_two_string: '::myVar',
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
        concrete_type: 'ConditionGlobal', compare_operator: 'GreaterThanOrEqualTo',
        comparison_value_float: null, comparison_value_form_key: '00000ABC:MyMod.esp',
      }, { function: 'IsSneaking' })],
      { '00000ABC:MyMod.esp': 'MyGlobal' },
    );
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking >= MyGlobal');
  });

  it('the OR flag writes OR, and the last element of the list carries no conjunction at all', async () => {
    currentCompare = oneColumn([
      condition({ flags: 1 }, { function: 'IsSneaking' }),
      condition({ flags: 1 }, { function: 'IsSneaking' }),
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
      concrete_type: 'GetEventData', function: null, event_function: 0, event_member: 0, parameter3: null,
    })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.GetEventData = 1.000000');
  });

  it('an expanded condition shows its members instead of the summary', async () => {
    currentCompare = oneColumn([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();
    fireEvent.click(screen.getAllByText('▶')[0]);

    await waitFor(() => screen.getByText('data'));
    expect(summaryOf(0)).toBe('');
  });
});

// The table's key is the leaf's type name: the discriminator's value where the leaf is a union,
// the schema's declared type name where it is not.

describe('#717 — the table keys on the leaf type name', () => {
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
    const noDiscriminator = condition({}, { function: 'IsSneaking' });
    delete noDiscriminator.concrete_type;
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
    const unnamed = condition({ concrete_type: null }, { function: 'IsSneaking' });
    currentCompare = oneColumn([unnamed], {}, declared);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('{…}');
  });
});

describe('#693 — a condition shows one row per parameter slot in use', () => {
  it('a record-slot function renders parameter_one_record and neither of its aliases', async () => {
    currentCompare = oneColumn([condition({}, {
      function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp',
    })]);
    renderPanel();
    await expandFirstConditionData();

    expect(screen.getByText('parameter_one_record')).toBeInTheDocument();
    expect(screen.queryByText('parameter_one_number')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_one_string')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_record')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_number')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_string')).not.toBeInTheDocument();
  });

  it('a number-slot function renders parameter_one_number and not the record twin sharing its four bytes', async () => {
    currentCompare = oneColumn([condition({}, {
      function: 'GetVATSValue', parameter_one_number: 10, parameter_two_number: 0,
    })]);
    renderPanel();
    await expandFirstConditionData();

    expect(screen.getByText('parameter_one_number')).toBeInTheDocument();
    expect(screen.getByText('parameter_two_number')).toBeInTheDocument();
    expect(screen.queryByText('parameter_one_record')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_record')).not.toBeInTheDocument();
  });

  it('Parameter #3 is written whatever the function is, so it is never hidden', async () => {
    currentCompare = oneColumn([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await expandFirstConditionData();

    expect(screen.getByText('unknown3')).toBeInTheDocument();
  });

  it('the reference row appears only under Run On = Reference', async () => {
    currentCompare = oneColumn([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await expandFirstConditionData();

    expect(screen.queryByText('reference')).not.toBeInTheDocument();
  });

  it('a slot any column uses is shown, so a conflicting override never hides its own data', async () => {
    currentCompare = compareResult({
      [PLUGIN]: [condition({}, { function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp' })],
      'Other.esp': [condition({}, { function: 'GetVATSValue', parameter_one_number: 3 })],
    });
    renderPanel();
    await expandFirstConditionData();

    expect(screen.getByText('parameter_one_record')).toBeInTheDocument();
    expect(screen.getByText('parameter_one_number')).toBeInTheDocument();
  });
});

describe('#693 — a governing member clears the siblings its new value idles', () => {
  it('changing Run On away from Reference posts an edit with the reference cleared', async () => {
    currentCompare = oneColumn([condition({}, {
      run_on_type: 'Reference', reference: '00000014:Fallout4.esm', function: 'IsSneaking',
    })]);
    renderPanel();
    const cell = await openMemberEditor('run_on_type');

    const select = cell.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'Subject' } });
    fireEvent.blur(select);

    const posted = lastEditField();
    expect(posted?.fieldPath).toBe('conditions');
    const data = (posted?.value as Record<string, unknown>[])[0].data as Record<string, unknown>;
    expect(data.run_on_type).toBe('Subject');
    expect(data.reference).toBeNull();
  });

  it('changing the function posts an edit with every slot the new function does not use cleared', async () => {
    // ConditionBinaryWriteTranslation.CustomStringExports writes a CIS1/CIS2 subrecord for any
    // non-null parameter string without consulting the function, so a stale string reaches the
    // plugin.
    currentCompare = oneColumn([condition({}, {
      function: 'GetGraphVariableFloat', parameter_one_string: 'bAllowRotation',
    })]);
    renderPanel();
    const cell = await openMemberEditor('function');

    const select = cell.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'HasKeyword' } });
    fireEvent.blur(select);

    const posted = lastEditField();
    const data = (posted?.value as Record<string, unknown>[])[0].data as Record<string, unknown>;
    expect(data.function).toBe('HasKeyword');
    // A JSON null into ParameterOneNumber — a non-nullable Int32 — is rejected by the write path,
    // and a rejected member fails the whole array write, so each slot empties per its own type.
    expect(data.parameter_one_string).toBeNull();
    expect(data.parameter_two_record).toBeNull();
    expect(data.parameter_two_string).toBeNull();
    expect(data.parameter_one_number).toBe(0);
    expect(data.parameter_two_number).toBe(0);
  });

  it('a member the new value still uses keeps its value', async () => {
    currentCompare = oneColumn([condition({}, {
      function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp',
    })]);
    renderPanel();
    const cell = await openMemberEditor('function');

    const select = cell.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'GetVMQuestVariable' } });
    fireEvent.blur(select);

    const data = (lastEditField()?.value as Record<string, unknown>[])[0].data as Record<string, unknown>;
    expect(data.parameter_one_record).toBe('00AABBCC:MyMod.esp');
  });

  it('an edit to a member that governs nothing leaves its siblings alone', async () => {
    currentCompare = oneColumn([condition({}, {
      function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp', unknown3: -1,
    })]);
    renderPanel();
    const cell = await openMemberEditor('unknown3');

    const input = cell.querySelector('input')!;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);

    const data = (lastEditField()?.value as Record<string, unknown>[])[0].data as Record<string, unknown>;
    expect(data.unknown3).toBe(7);
    expect(data.parameter_one_record).toBe('00AABBCC:MyMod.esp');
  });
});

describe('#693 — the function picker comes from the schema', () => {
  it('Fallout 4 picks the function from the function member’s own enum', async () => {
    currentCompare = oneColumn([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await waitFor(() => screen.getByText('conditions'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
    const el0 = screen.getAllByText('[0]').find(e => e.tagName === 'TD')!;
    fireEvent.click(el0.closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('data'));
    fireEvent.click(screen.getByText('data').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('function'));

    const cell = screen.getByText('function').closest('tr')!.querySelectorAll('td')[1];
    fireEvent.doubleClick(cell.querySelector('[data-open-trigger]')!);
    const options = Array.from(cell.querySelector('select')!.options).map(o => o.value);
    expect(options).toEqual(Object.keys(FUNCTION_SLOTS));
  });
});

describe('#693 — a Run On label that contains spaces', () => {
  // xEdit writes the Run On prefix with its spaces stripped. No Fallout 4 enum reaches the
  // webview labelled at all, so the rule is stated against a labelled run_on_type instead.
  const labelled: FieldMetadata = {
    ...conditionsMeta,
    elementType: {
      ...conditionsMeta.elementType!,
      fields: conditionsMeta.elementType!.fields!.map(f => (f.name !== 'data' ? f : {
        ...f,
        fields: f.fields!.map(m => (m.name !== 'run_on_type' ? m : {
          ...m,
          enumMembers: m.enumMembers.map(e => ({ ...e, label: e.value.replace('CombatTarget', 'Combat Target') })),
        })),
      })),
    },
  };

  it('strips them, so the prefix reads as one word', async () => {
    const element = condition({}, { run_on_type: 'CombatTarget', function: 'IsSneaking' });
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
