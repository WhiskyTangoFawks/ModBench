import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { AddPropertyButton, AddPropertyDialog, RemovePropertyButton, SetTypeControl, PropertyFlagsControl } from './VmadPropertyOps';
import type { RecordSessionClient } from './RecordSessionClient';

const stubClient = { searchRecords: vi.fn().mockResolvedValue([]) } as unknown as RecordSessionClient;

describe('AddPropertyButton', () => {
  it('opens the Add property dialog on click', () => {
    render(<AddPropertyButton plugin="A.esm" scriptName="S" onStructOp={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Add property'));
    expect(screen.getByText('Add property')).toBeInTheDocument();
  });

  it('confirming stages an add_property op scoped to the script and plugin', () => {
    const onStructOp = vi.fn();
    render(<AddPropertyButton plugin="A.esm" scriptName="S" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Add property'));

    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'Alpha' } });
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Int' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '7' } });
    fireEvent.click(screen.getByText('Add'));

    expect(onStructOp).toHaveBeenCalledWith(
      'A.esm',
      String.raw`VMAD\S\Alpha`,
      { op: 'add_property', type: 'Int', name: 'Alpha', flags: 'Edited', value: 7 },
    );
  });
});

describe('AddPropertyDialog — value control per type', () => {
  it('defaults to an Int value control', () => {
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('New property value')).toHaveAttribute('type', 'number');
  });

  it('switches to a checkbox for Bool', () => {
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Bool' } });
    expect(screen.getByLabelText('New property value')).toHaveAttribute('type', 'checkbox');
  });

  it('switches to a text input for String', () => {
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'String' } });
    expect(screen.getByLabelText('New property value')).toHaveAttribute('type', 'text');
  });

  it('shows an empty placeholder for non-scalar types with no client', () => {
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Object' } });
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('offers a FormKey picker for Object when a client is supplied', () => {
    render(<AddPropertyDialog client={stubClient} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Object' } });
    fireEvent.click(screen.getByLabelText('New property value'));
    expect(screen.getByPlaceholderText('Search EditorID…')).toBeInTheDocument();
  });

  it('disables Add until a name is entered', () => {
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Add')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'X' } });
    expect(screen.getByText('Add')).not.toBeDisabled();
  });

  it('calls onCancel on Cancel', () => {
    const onCancel = vi.fn();
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('RemovePropertyButton', () => {
  it('stages a remove_property op for the plugin/script/property', () => {
    const onStructOp = vi.fn();
    render(<RemovePropertyButton plugin="A.esm" scriptName="S" propName="IsActive" onStructOp={onStructOp} />);
    fireEvent.click(screen.getByTitle('Remove property'));
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\IsActive`, { op: 'remove_property' });
  });
});

describe('SetTypeControl', () => {
  it('shows the current type selected', () => {
    render(<SetTypeControl plugin="A.esm" scriptName="S" propName="Counter" currentType="Int" onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Type for Counter')).toHaveValue('Int');
  });

  it('shows the raw type as an extra option when it is not a known addable type', () => {
    render(<SetTypeControl plugin="A.esm" scriptName="S" propName="Counter" currentType="Variable" onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Type for Counter')).toHaveValue('');
    expect(screen.getByText('Variable')).toBeInTheDocument();
  });

  it('changing the selection stages a set_type op', () => {
    const onStructOp = vi.fn();
    render(<SetTypeControl plugin="A.esm" scriptName="S" propName="Counter" currentType="Int" onStructOp={onStructOp} />);
    fireEvent.change(screen.getByLabelText('Type for Counter'), { target: { value: 'Float' } });
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Counter`, { op: 'set_type', type: 'Float' });
  });
});

describe('PropertyFlagsControl', () => {
  it('defaults to Edited', () => {
    render(<PropertyFlagsControl plugin="A.esm" scriptName="S" propName="Counter" onStructOp={vi.fn()} />);
    expect(screen.getByLabelText('Flags for Counter')).toHaveValue('Edited');
  });

  it('changing the selection stages a set_flags op', () => {
    const onStructOp = vi.fn();
    render(<PropertyFlagsControl plugin="A.esm" scriptName="S" propName="Counter" onStructOp={onStructOp} />);
    fireEvent.change(screen.getByLabelText('Flags for Counter'), { target: { value: 'Removed' } });
    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Counter`, { op: 'set_flags', flags: 'Removed' });
  });
});
