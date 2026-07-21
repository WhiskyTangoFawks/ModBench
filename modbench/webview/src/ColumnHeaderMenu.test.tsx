import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ColumnHeaderMenu } from './ColumnHeaderMenu';

describe('ColumnHeaderMenu', () => {
  it('renders the three menu items', () => {
    render(<ColumnHeaderMenu x={10} y={20} disabledRemove={false} onClose={vi.fn()} onCopyAllToPending={vi.fn()} onCopyAsNewRecord={vi.fn()} onRemoveOverride={vi.fn()} />);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as New Record' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toBeInTheDocument();
  });

  it('calls the matching handler when an item is clicked', () => {
    const onCopyAllToPending = vi.fn();
    render(<ColumnHeaderMenu x={10} y={20} disabledRemove={false} onClose={vi.fn()} onCopyAllToPending={onCopyAllToPending} onCopyAsNewRecord={vi.fn()} onRemoveOverride={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));
    expect(onCopyAllToPending).toHaveBeenCalled();
  });

  it('disables Remove Override when disabledRemove is true', () => {
    render(<ColumnHeaderMenu x={10} y={20} disabledRemove={true} onClose={vi.fn()} onCopyAllToPending={vi.fn()} onCopyAsNewRecord={vi.fn()} onRemoveOverride={vi.fn()} />);
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    render(<ColumnHeaderMenu x={10} y={20} disabledRemove={false} onClose={onClose} onCopyAllToPending={vi.fn()} onCopyAsNewRecord={vi.fn()} onRemoveOverride={vi.fn()} />);
    fireEvent.click(window);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ColumnHeaderMenu x={10} y={20} disabledRemove={false} onClose={onClose} onCopyAllToPending={vi.fn()} onCopyAsNewRecord={vi.fn()} onRemoveOverride={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close on other key presses', () => {
    const onClose = vi.fn();
    render(<ColumnHeaderMenu x={10} y={20} disabledRemove={false} onClose={onClose} onCopyAllToPending={vi.fn()} onCopyAsNewRecord={vi.fn()} onRemoveOverride={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
