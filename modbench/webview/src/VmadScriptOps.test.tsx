import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { AddScriptButton, AddScriptDialog, RemoveScriptButton, ScriptFlagsControl } from './VmadScriptOps';

describe('AddScriptButton', () => {
  it('opens the Add script dialog on click', () => {
    render(<AddScriptButton plugin="A.esm" onStructOp={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Add script'));
    expect(screen.getByText('Add script')).toBeInTheDocument();
  });

  it('confirming stages an add_script op scoped to the plugin', () => {
    const onStructOp = vi.fn();
    render(<AddScriptButton plugin="A.esm" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Add script'));

    fireEvent.change(screen.getByLabelText('New script name'), { target: { value: 'MyScript' } });
    fireEvent.change(screen.getByLabelText('New script flags'), { target: { value: 'Local' } });
    fireEvent.click(screen.getByText('Add'));

    expect(onStructOp).toHaveBeenCalledWith(
      'A.esm',
      String.raw`VMAD\MyScript`,
      { op: 'add_script', name: 'MyScript', flags: 'Local', properties: [] },
    );
  });
});

describe('AddScriptDialog', () => {
  it('disables Add until a name is entered', () => {
    render(<AddScriptDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Add')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New script name'), { target: { value: 'X' } });
    expect(screen.getByText('Add')).not.toBeDisabled();
  });

  it('offers all script flags in the dropdown', () => {
    render(<AddScriptDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByLabelText('New script flags');
    expect(select).toHaveValue('Local');
    for (const f of ['Local', 'Inherited', 'Removed', 'InheritedAndRemoved']) {
      expect(screen.getByRole('option', { name: f })).toBeInTheDocument();
    }
  });

  it('calls onCancel on Cancel', () => {
    const onCancel = vi.fn();
    render(<AddScriptDialog onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('RemoveScriptButton', () => {
  it('stages a remove_script op for the plugin/script', () => {
    const onStructOp = vi.fn();
    render(<RemoveScriptButton plugin="A.esm" scriptName="S" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Remove script'));
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S`, { op: 'remove_script' });
  });
});

describe('ScriptFlagsControl', () => {
  it('reflects the current flag', () => {
    render(<ScriptFlagsControl plugin="A.esm" scriptName="S" current="Inherited" onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Flags for S')).toHaveValue('Inherited');
  });

  it('defaults to Local when there is no current flag', () => {
    render(<ScriptFlagsControl plugin="A.esm" scriptName="S" current={null} onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Flags for S')).toHaveValue('Local');
  });

  it('changing the selection stages a set_flags op', () => {
    const onStructOp = vi.fn();
    render(<ScriptFlagsControl plugin="A.esm" scriptName="S" current="Local" onStructOp={onStructOp} />);
    fireEvent.change(screen.getByLabelText('Flags for S'), { target: { value: 'Inherited' } });
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S`, { op: 'set_flags', flags: 'Inherited' });
  });
});
