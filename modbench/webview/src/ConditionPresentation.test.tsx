import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./vscode', () => ({ vscode: { postMessage: vi.fn() } }));

import { RecordPanel } from './RecordPanel';
import type { FieldMetadata } from './types';
import { columnKey } from './types';
import type { LoadResult, RecordPanelClient } from './RecordPanelClient';
import { vscode } from './vscode';
import { WEBVIEW_TO_EXTENSION } from './messages';

// #693: what a condition reads as, and which of its rows exist.
//
// The metadata below is the Fallout 4 schema's own shape, verbatim from
// MEditService.Tests' ConditionSchemaTests (the two discriminators, ComparisonValue split per
// shape, the six aliased parameter slots, and the two SiblingsInUse maps) — trimmed to the
// enum members these cases name, never restructured. `siblingsInUse` rows are copied from
// Condition.GetParameterTypes' own answers for those functions.

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
    leaf('concrete_type', 'enum', {
      displayLabel: 'Kind',
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
        displayLabel: 'Kind',
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
  flags: '0',
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

// One column, one conditions column, N elements — the member diffs the summary reads its
// resolutions from are built here from each element's own value.
function compareResult(elements: Condition[], resolutions: Record<string, string> = {}) {
  const memberChildren = (el: Condition, prefix: string): unknown[] =>
    Object.entries(el).map(([name, value]) => ({
      fieldName: name,
      values: { [PLUGIN]: value },
      winnerColumn: PLUGIN, winnerValue: value, cellStates: {},
      resolutions: typeof value === 'string' && resolutions[value]
        ? { [PLUGIN]: { state: 'ResolvedValidType', recordType: null, editorId: resolutions[value] } }
        : undefined,
      children: name === 'data'
        ? memberChildren(value as Condition, `${prefix}.data`)
        : undefined,
    }));

  return {
    conflictAll: 'NoConflict',
    overrides: [{
      formKey: '000001:MyMod.esp', plugin: PLUGIN, origin: 'Data',
      loadOrderIndex: 1, isWinner: true, editorId: 'TestCobj',
      fields: [{ metadata: conditionsMeta, value: elements }], conflictThis: 'Master',
    }],
    diffs: [{
      fieldName: 'conditions',
      values: { [PLUGIN]: elements },
      winnerColumn: PLUGIN, winnerValue: elements, cellStates: {},
      children: elements.map((el, i) => ({
        fieldName: `[${i}]`,
        values: { [PLUGIN]: el },
        winnerColumn: PLUGIN, winnerValue: el, cellStates: {},
        children: memberChildren(el, `[${i}]`),
      })),
    }],
  };
}

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

// ── AC1: the collapsed row reads as xEdit's own wbConditionToStr ──────────────

describe('#693 — a collapsed condition reads as xEdit prose', () => {
  it('run on, function, both parameter slots, operator, float to six places, and the AND that follows a non-last element', async () => {
    currentCompare = compareResult(
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
    currentCompare = compareResult(
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
    currentCompare = compareResult([condition({ compare_operator: 'NotEqualTo' }, { function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking <> 1.000000');
  });

  it('a string parameter is written without parentheses — xEdit ignores the slot, the value has its own row', async () => {
    currentCompare = compareResult([condition({}, {
      function: 'GetGraphVariableFloat', parameter_one_string: 'bAllowRotation',
    })]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.GetGraphVariableFloat = 1.000000');
  });

  it('both record slots read as short names', async () => {
    currentCompare = compareResult(
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
    currentCompare = compareResult(
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
    currentCompare = compareResult(
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
    currentCompare = compareResult([
      condition({ flags: '1' }, { function: 'IsSneaking' }),
      condition({ flags: '1' }, { function: 'IsSneaking' }),
    ]);
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('Subject.IsSneaking = 1.000000 OR');
    expect(summaryOf(1)).toBe('Subject.IsSneaking = 1.000000');
  });

  it('an expanded condition shows its members instead of the summary', async () => {
    currentCompare = compareResult([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await expandConditions();
    fireEvent.click(screen.getAllByText('▶')[0]);

    await waitFor(() => screen.getByText('data'));
    expect(summaryOf(0)).toBe('');
  });
});

// ── AC2: one row per parameter slot the function actually uses ────────────────

describe('#693 — a condition shows one row per parameter slot in use', () => {
  async function expandData(index: number) {
    await expandConditions();
    const td = screen.getAllByText(`[${index}]`).find(el => el.tagName === 'TD')!;
    fireEvent.click(td.closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('data'));
    fireEvent.click(screen.getByText('data').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('function'));
  }

  it('a record-slot function renders parameter_one_record and neither of its aliases', async () => {
    currentCompare = compareResult([condition({}, {
      function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp',
    })]);
    renderPanel();
    await expandData(0);

    expect(screen.getByText('parameter_one_record')).toBeInTheDocument();
    expect(screen.queryByText('parameter_one_number')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_one_string')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_record')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_number')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_string')).not.toBeInTheDocument();
  });

  it('a number-slot function renders parameter_one_number and not the record twin sharing its four bytes', async () => {
    currentCompare = compareResult([condition({}, {
      function: 'GetVATSValue', parameter_one_number: 10, parameter_two_number: 0,
    })]);
    renderPanel();
    await expandData(0);

    expect(screen.getByText('parameter_one_number')).toBeInTheDocument();
    expect(screen.getByText('parameter_two_number')).toBeInTheDocument();
    expect(screen.queryByText('parameter_one_record')).not.toBeInTheDocument();
    expect(screen.queryByText('parameter_two_record')).not.toBeInTheDocument();
  });

  it('Parameter #3 is written whatever the function is, so it is never hidden', async () => {
    currentCompare = compareResult([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await expandData(0);

    expect(screen.getByText('unknown3')).toBeInTheDocument();
  });

  it('the reference row appears only under Run On = Reference', async () => {
    currentCompare = compareResult([condition({}, { function: 'IsSneaking' })]);
    renderPanel();
    await expandData(0);

    expect(screen.queryByText('reference')).not.toBeInTheDocument();
  });

  it('a slot any column uses is shown, so a conflicting override never hides its own data', async () => {
    const mine = condition({}, { function: 'HasKeyword', parameter_one_record: '00AABBCC:MyMod.esp' });
    const theirs = condition({}, { function: 'GetVATSValue', parameter_one_number: 3 });
    const base = compareResult([mine]);
    const withTwoColumns = {
      ...base,
      overrides: [
        ...base.overrides,
        {
          formKey: '000001:MyMod.esp', plugin: 'Other.esp', origin: 'Data',
          loadOrderIndex: 2, isWinner: false, editorId: 'TestCobj',
          fields: [{ metadata: conditionsMeta, value: [theirs] }], conflictThis: 'Override',
        },
      ],
      diffs: base.diffs.map(d => ({
        ...d,
        values: { ...d.values, 'Other.esp': [theirs] },
        children: d.children.map(c => ({
          ...c,
          values: { ...c.values, 'Other.esp': theirs },
          children: (c.children as { fieldName: string; values: Record<string, unknown> }[]).map(m => ({
            ...m,
            values: { ...m.values, 'Other.esp': theirs[m.fieldName] },
            children: m.fieldName === 'data'
              ? ((m as unknown as { children: { fieldName: string; values: Record<string, unknown> }[] }).children)
                .map(dm => ({
                  ...dm,
                  values: { ...dm.values, 'Other.esp': (theirs.data as Record<string, unknown>)[dm.fieldName] },
                }))
              : undefined,
          })),
        })),
      })),
    };
    currentCompare = withTwoColumns;
    renderPanel();
    await expandData(0);

    expect(screen.getByText('parameter_one_record')).toBeInTheDocument();
    expect(screen.getByText('parameter_one_number')).toBeInTheDocument();
  });
});

// ── AC3: the cascades a governing member declares ─────────────────────────────

describe('#693 — a governing member clears the siblings its new value idles', () => {
  async function openMemberEditor(memberName: string) {
    await waitFor(() => screen.getByText('conditions'));
    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => expect(screen.getAllByText('[0]').some(el => el.tagName === 'TD')).toBe(true));
    const el0 = screen.getAllByText('[0]').find(e => e.tagName === 'TD')!;
    fireEvent.click(el0.closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('data'));
    fireEvent.click(screen.getByText('data').closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText(memberName));
    const cell = screen.getByText(memberName).closest('tr')!.querySelectorAll('td')[1];
    fireEvent.doubleClick(cell.querySelector('[data-open-trigger]')!);
    return cell;
  }

  it('changing Run On away from Reference posts an edit with the reference cleared', async () => {
    currentCompare = compareResult([condition({}, {
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
    // non-null parameter string without consulting the function, so a string left behind by a
    // function change reaches the plugin. The cleared parameter_one_string below is that fix.
    currentCompare = compareResult([condition({}, {
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
    expect(data.parameter_one_string).toBeNull();
    expect(data.parameter_one_number).toBeNull();
    expect(data.parameter_two_record).toBeNull();
    expect(data.parameter_two_number).toBeNull();
    expect(data.parameter_two_string).toBeNull();
  });

  it('a member the new value still uses keeps its value', async () => {
    currentCompare = compareResult([condition({}, {
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
    currentCompare = compareResult([condition({}, {
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

// ── AC4: the function picker is the schema's own enum ─────────────────────────

describe('#693 — the function picker comes from the schema', () => {
  it('Fallout 4 picks the function from the function member’s own enum', async () => {
    currentCompare = compareResult([condition({}, { function: 'IsSneaking' })]);
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

// ── A condition shape whose function is the discriminator ────────────────────
//
// HAND-AUTHORED, and unverified against any schema: this repo builds no Skyrim or Starfield
// schema, so nothing here was read off an assembly the way the Fallout 4 metadata above was.
// #706 owns real verification. What it pins is the *formatter's* two rules that Fallout 4's own
// schema cannot exercise — a Run On label that contains spaces, and a condition whose function is
// named by the leaf discriminator rather than by a function member of its own.

const discriminatorShapedMeta: FieldMetadata = {
  ...conditionsMeta,
  elementType: {
    ...conditionsMeta.elementType!,
    fields: conditionsMeta.elementType!.fields!.map(f => (f.name !== 'data' ? f : {
      ...f,
      fields: [
        leaf('run_on_type', 'enum', {
          enumMembers: [
            { value: 'Subject', bitValue: null, label: 'Subject' },
            { value: 'CombatTarget', bitValue: null, label: 'Combat Target' },
          ],
        }),
        leaf('concrete_type', 'enum', {
          displayLabel: 'Kind',
          enumMembers: [
            { value: 'GetStageConditionData', bitValue: null, label: 'Get Stage' },
            { value: 'GetItemCountConditionData', bitValue: null, label: 'Get Item Count' },
          ],
        }),
      ],
    })),
  },
};

describe('#693 — a condition whose function is its discriminator (hand-authored shape)', () => {
  const element = {
    concrete_type: 'ConditionFloat',
    compare_operator: 'EqualTo',
    flags: '0',
    comparison_value_float: 1,
    comparison_value_form_key: null,
    data: { concrete_type: 'GetStageConditionData', run_on_type: 'CombatTarget' },
  };

  beforeEach(() => {
    const base = compareResult([element]);
    currentCompare = {
      ...base,
      overrides: [{ ...base.overrides[0], fields: [{ metadata: discriminatorShapedMeta, value: [element] }] }],
    };
  });

  it('strips the spaces out of the Run On label, and names the function from the leaf', async () => {
    renderPanel();
    await expandConditions();

    expect(summaryOf(0)).toBe('CombatTarget.GetStageConditionData = 1.000000');
  });

  it('picks the function from the discriminator’s own dropdown', async () => {
    renderPanel();
    await expandConditions();
    const el0 = screen.getAllByText('[0]').find(e => e.tagName === 'TD')!;
    fireEvent.click(el0.closest('tr')!.querySelector('button')!);
    await waitFor(() => screen.getByText('data'));
    fireEvent.click(screen.getByText('data').closest('tr')!.querySelector('button')!);
    // Addressed by the leaf it currently holds — two Kind rows are on screen, the condition's own
    // and the data's, and only this one reads "Get Stage".
    await waitFor(() => screen.getByText('Get Stage'));

    fireEvent.doubleClick(screen.getByText('Get Stage'));
    expect(within(screen.getByRole('combobox')).getAllByRole('option').map(o => o.textContent))
      .toEqual(['Get Stage', 'Get Item Count']);
  });
});
