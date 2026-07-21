import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { RevertGroupConfirm } from './RevertGroupConfirm';
import type { PendingChange } from './types';

function change(partial: Partial<PendingChange> & Pick<PendingChange, 'id'>): PendingChange {
  return {
    formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'Name', recordType: 'Npc',
    oldValue: 'a', newValue: 'b', source: 'agent', description: null, changedAt: '2026-06-20T12:00:00Z',
    ...partial,
  };
}

describe('RevertGroupConfirm', () => {
  it('shows the confirmation title and Revert confirm button', () => {
    render(<RevertGroupConfirm members={[change({ id: 'c1' })]} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Revert this group? All linked edits are reverted together.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert' })).toBeInTheDocument();
  });

  it('lists every member by recordType / formKey · fieldPath', () => {
    render(<RevertGroupConfirm
      members={[
        change({ id: 'c1', recordType: 'Npc', formKey: '000001:Fallout4.esm', fieldPath: 'Name' }),
        change({ id: 'c2', recordType: 'Npc', formKey: '000001:Fallout4.esm', fieldPath: 'Race' }),
      ]}
      onConfirm={vi.fn()} onCancel={vi.fn()}
    />);
    expect(screen.getByText('Npc / 000001:Fallout4.esm · Name')).toBeInTheDocument();
    expect(screen.getByText('Npc / 000001:Fallout4.esm · Race')).toBeInTheDocument();
  });

  it('calls onConfirm when Revert is clicked', () => {
    const onConfirm = vi.fn();
    render(<RevertGroupConfirm members={[change({ id: 'c1' })]} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<RevertGroupConfirm members={[change({ id: 'c1' })]} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
