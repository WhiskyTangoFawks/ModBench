import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ColumnHeaderMenu } from './ColumnHeaderMenu';

function baseProps() {
  return {
    x: 10, y: 20, disabledRemove: false,
    onClose: vi.fn(), onCopyAllToPending: vi.fn(), onCopyAsNewRecord: vi.fn(),
    onCopyAsOverride: vi.fn(), onRemoveOverride: vi.fn(),
  };
}

describe('ColumnHeaderMenu', () => {
  it('renders the four menu items', () => {
    render(<ColumnHeaderMenu {...baseProps()} />);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as New Record' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy as Override…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toBeInTheDocument();
  });

  it('calls the matching handler when an item is clicked', () => {
    const onCopyAllToPending = vi.fn();
    render(<ColumnHeaderMenu {...baseProps()} onCopyAllToPending={onCopyAllToPending} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy All to Pending' }));
    expect(onCopyAllToPending).toHaveBeenCalled();
  });

  it('calls onCopyAsOverride when Copy as Override… is clicked', () => {
    const onCopyAsOverride = vi.fn();
    render(<ColumnHeaderMenu {...baseProps()} onCopyAsOverride={onCopyAsOverride} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Override…' }));
    expect(onCopyAsOverride).toHaveBeenCalled();
  });

  it('disables Remove Override when disabledRemove is true', () => {
    render(<ColumnHeaderMenu {...baseProps()} disabledRemove={true} />);
    expect(screen.getByRole('menuitem', { name: 'Remove Override' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    render(<ColumnHeaderMenu {...baseProps()} onClose={onClose} />);
    fireEvent.click(window);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ColumnHeaderMenu {...baseProps()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close on other key presses', () => {
    const onClose = vi.fn();
    render(<ColumnHeaderMenu {...baseProps()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
