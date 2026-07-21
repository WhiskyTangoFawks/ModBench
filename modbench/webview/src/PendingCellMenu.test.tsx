import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PendingCellMenu } from './PendingCellMenu';

describe('PendingCellMenu', () => {
  it('renders Save Group and Revert Group items', () => {
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    expect(screen.getByRole('menuitem', { name: 'Save Group' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Revert Group' })).toBeInTheDocument();
  });

  it('calls onSaveGroup when Save Group is clicked', () => {
    const onSaveGroup = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onSaveGroup={onSaveGroup} onRevertGroup={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save Group' }));
    expect(onSaveGroup).toHaveBeenCalled();
  });

  it('calls onRevertGroup when Revert Group is clicked', () => {
    const onRevertGroup = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={vi.fn()} onSaveGroup={vi.fn()} onRevertGroup={onRevertGroup} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert Group' }));
    expect(onRevertGroup).toHaveBeenCalled();
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={onClose} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    fireEvent.click(window);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<PendingCellMenu x={10} y={20} onClose={onClose} onSaveGroup={vi.fn()} onRevertGroup={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
