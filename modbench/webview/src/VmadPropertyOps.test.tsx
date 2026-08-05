import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Issue #210: the Object-value control now calls pickFormKey (the native-QuickPick bridge)
// instead of rendering an inline picker. Mocked here so these tests assert the call, not any
// rendered picker DOM.
const pickFormKey = vi.fn().mockResolvedValue(null);
vi.mock('./nativeBridge', () => ({ pickFormKey: (...args: unknown[]) => pickFormKey(...args) }));

import { AddPropertyDialog } from './VmadPropertyOps';

// Issue #231: AddPropertyButton/RemovePropertyButton/SetTypeControl/PropertyFlagsControl (and
// their own tests, previously here) are deleted along with VmadSection — structural ops are
// right-click-menu-only now (ADR-0034's no-second-route rule), covered end to end in
// RecordPanel.test.tsx's "VMAD structural-op right-click menu" suite. AddPropertyDialog is the
// one survivor (#229's deliberate webview-modal exception), now opened by RecordPanel directly.

describe('AddPropertyDialog — value control per type', () => {
  afterEach(() => { pickFormKey.mockClear(); });

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

  // Issue #210: there's no current reference for a brand-new property, so the picker opens with
  // an empty seed — never "(empty)"'s unconditioned-on-client fallback (that gate went away with
  // the inline picker; the button is always the Object-type control now).
  it('clicking the value control for Object opens the picker with an empty seed', () => {
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Object' } });
    fireEvent.click(screen.getByLabelText('New property value'));
    expect(pickFormKey).toHaveBeenCalledWith('', []);
  });

  it('shows the picked FormKey on the button once pickFormKey resolves', async () => {
    pickFormKey.mockResolvedValueOnce('00001A:Fallout4.esm');
    render(<AddPropertyDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Object' } });
    fireEvent.click(screen.getByLabelText('New property value'));
    await vi.waitFor(() => expect(screen.getByText('00001A:Fallout4.esm')).toBeInTheDocument());
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

  it('confirming calls onConfirm with the entered name/type/value', () => {
    const onConfirm = vi.fn();
    render(<AddPropertyDialog onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'Alpha' } });
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Int' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '7' } });
    fireEvent.click(screen.getByText('Add'));
    expect(onConfirm).toHaveBeenCalledWith({ name: 'Alpha', type: 'Int', value: 7 });
  });
});
