import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PendingCellMenu } from './PendingCellMenu';

describe('PendingCellMenu', () => {
  it('renders Reveal, Save Group, and Revert Group items', () => {
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onReveal={vi.fn()} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    expect(screen.getByRole('menuitem', { name: 'Reveal in Pending Changes Tree' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save Group' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Revert Group' })).toBeInTheDocument();
  });

  // Issue #203: reveal moved here from plain-click on the pending cell — it joins Save Group /
  // Revert Group as the third action on this menu, and sorts first (the read-only "what is this"
  // action before the two mutating ones).
  it('calls onReveal when Reveal in Pending Changes Tree is clicked', () => {
    const onReveal = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onReveal={onReveal} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Pending Changes Tree' }));
    expect(onReveal).toHaveBeenCalled();
  });

  it('calls onSaveGroup when Save Group is clicked', () => {
    const onSaveGroup = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onReveal={vi.fn()} onSaveGroup={onSaveGroup} onRevertGroup={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));
    expect(onSaveGroup).toHaveBeenCalled();
  });

  it('calls onRevertGroup when Revert Group is clicked', () => {
    const onRevertGroup = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onReveal={vi.fn()} onSaveGroup={vi.fn()} onRevertGroup={onRevertGroup} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert Group' }));
    expect(onRevertGroup).toHaveBeenCalled();
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={onClose} onReveal={vi.fn()} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    fireEvent.click(window);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={onClose} onReveal={vi.fn()} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
