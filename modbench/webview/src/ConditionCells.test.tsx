import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const pickConditionFunction = vi.fn().mockResolvedValue(null);
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({
  pickConditionFunction: (...args: unknown[]) => pickConditionFunction(...args),
  pickFormKey: (...args: unknown[]) => pickFormKey(...args),
}));

import { ConditionFunctionCell, ConditionRunOnCell, ConditionComparisonCell, ConditionParamCell } from './ConditionCells';
import type { FieldMetadata } from './types';

// Issue #167: ConditionRunOnCell's dropdown options come from `meta.enumValues` (the server's Run
// On target catalog) rather than a hardcoded FO4 member list — this fixture stands in for whatever
// GET /condition-run-on-targets resolved to.
function runOnMeta(enumValues: string[]): FieldMetadata {
  return { name: '', type: 'conditionRunOn', isArray: false, validFormKeyTypes: [], enumValues };
}
const FO4_RUN_ON_TARGETS = [
  'Subject', 'Target', 'Reference', 'CombatTarget', 'LinkedReference', 'QuestAlias',
  'PackageData', 'EventData', 'CommandTarget', 'EventCameraRef', 'MyKiller',
];

describe('ConditionFunctionCell', () => {
  afterEach(() => { pickConditionFunction.mockClear(); });

  it('renders the current function name as a button when editable', () => {
    render(<ConditionFunctionCell value="GetIsID" editable onCommit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'GetIsID' })).toBeInTheDocument();
  });

  it('renders plain text (no button) when not editable', () => {
    render(<ConditionFunctionCell value="GetIsID" editable={false} onCommit={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('GetIsID')).toBeInTheDocument();
  });

  it('a click opens the QuickPick and commits the picked function', async () => {
    pickConditionFunction.mockResolvedValue('GetStageDone');
    const onCommit = vi.fn();
    render(<ConditionFunctionCell value="GetIsID" editable onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button'));
    expect(pickConditionFunction).toHaveBeenCalledWith('GetIsID');
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith('GetStageDone'));
  });

  it('does nothing when not focused (matches FormKeyCell\'s isFocused gate)', () => {
    render(<ConditionFunctionCell value="GetIsID" editable isFocused={false} onCommit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));
    expect(pickConditionFunction).not.toHaveBeenCalled();
  });
});

describe('ConditionRunOnCell', () => {
  // Issue #223 / ADR-0034: a scalar/enum leaf reads as text until clicked (isFocused defaults to
  // true for a caller outside the field grid's own focus model, matching ScalarCell's documented
  // "open-on-any-click" contract for exactly this kind of standalone usage) — click first, then
  // assert on the opened editor, the same convention VmadObjectEditor.test.tsx already uses.
  it('shows only the target enum when the target is not Reference', () => {
    render(<ConditionRunOnCell value={{ target: 'Subject', reference: null }} meta={runOnMeta(FO4_RUN_ON_TARGETS)} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('Subject'));
    expect(screen.getByDisplayValue('Subject')).toBeInTheDocument();
  });

  it('also shows a FormKey cell when the target is Reference', () => {
    render(<ConditionRunOnCell value={{ target: 'Reference', reference: '000010:Fallout4.esm' }} meta={runOnMeta(FO4_RUN_ON_TARGETS)} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('000010:Fallout4.esm')).toBeInTheDocument();
  });

  it('changing the target to Reference commits {target, reference: null}', () => {
    const onCommit = vi.fn();
    render(<ConditionRunOnCell value={{ target: 'Subject', reference: null }} meta={runOnMeta(FO4_RUN_ON_TARGETS)} editable onCommit={onCommit} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('Subject'));
    const select = screen.getByDisplayValue('Subject');
    fireEvent.change(select, { target: { value: 'Reference' } });
    fireEvent.blur(select);
    expect(onCommit).toHaveBeenCalledWith({ target: 'Reference', reference: null });
  });

  // Issue #167: the actual regression test — the dropdown's options are whatever `meta.enumValues`
  // says, not a hardcoded FO4 member list. A list with names foreign to FO4's RunOnType (and
  // missing several real FO4 members) still renders exactly as given, proving there's no fallback
  // list baked into this component.
  it('renders exactly the options meta.enumValues provides, not a hardcoded FO4 list', () => {
    render(<ConditionRunOnCell value={{ target: 'Foo', reference: null }} meta={runOnMeta(['Foo', 'Bar'])} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('Foo'));
    const select = screen.getByDisplayValue<HTMLSelectElement>('Foo');
    const options = Array.from(select.options).map(o => o.value);
    expect(options).toEqual(['Foo', 'Bar']);
  });
});

describe('ConditionComparisonCell', () => {
  it('renders a number editor when the value is a number (float comparison)', () => {
    render(<ConditionComparisonCell value={42} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('42'));
    expect(screen.getByDisplayValue('42')).toBeInTheDocument();
  });

  it('renders a FormKey cell when the value is a string (GLOB comparison)', () => {
    render(<ConditionComparisonCell value="000020:Fallout4.esm" editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('000020:Fallout4.esm')).toBeInTheDocument();
  });
});

describe('ConditionParamCell', () => {
  it('renders a FormKey cell for a Form-category parameter', () => {
    render(<ConditionParamCell value={{ category: 'Form', typeName: 'ActorValue', formKey: '000030:Fallout4.esm' }} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('000030:Fallout4.esm')).toBeInTheDocument();
    expect(screen.getByText('(ActorValue)')).toBeInTheDocument();
  });

  it('renders a text editor for a Text-category parameter', () => {
    render(<ConditionParamCell value={{ category: 'Text', typeName: 'String', text: 'MQ101' }} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('MQ101'));
    expect(screen.getByDisplayValue('MQ101')).toBeInTheDocument();
  });

  it('renders a number editor for a Number-category parameter', () => {
    render(<ConditionParamCell value={{ category: 'Number', typeName: 'Int', number: 5 }} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('5'));
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
  });

  it('shows a dash when the parameter is absent for this plugin', () => {
    render(<ConditionParamCell value={null} editable onCommit={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
