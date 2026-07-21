import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ColumnHeaderMenuItem } from './ColumnHeaderMenuItem';

describe('ColumnHeaderMenuItem', () => {
  it('renders the label as a menuitem', () => {
    render(<ul><ColumnHeaderMenuItem label="Copy All to Pending" onActivate={vi.fn()} /></ul>);
    expect(screen.getByRole('menuitem', { name: 'Copy All to Pending' })).toBeInTheDocument();
  });

  it('calls onActivate on click', () => {
    const onActivate = vi.fn();
    render(<ul><ColumnHeaderMenuItem label="Remove Override" onActivate={onActivate} /></ul>);
    fireEvent.click(screen.getByRole('menuitem'));
    expect(onActivate).toHaveBeenCalled();
  });

  it('calls onActivate on Enter and Space keydown', () => {
    const onActivate = vi.fn();
    render(<ul><ColumnHeaderMenuItem label="Remove Override" onActivate={onActivate} /></ul>);
    const item = screen.getByRole('menuitem');
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: ' ' });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('when disabled, does not call onActivate on click or keydown', () => {
    const onActivate = vi.fn();
    render(<ul><ColumnHeaderMenuItem label="Remove Override" disabled onActivate={onActivate} /></ul>);
    const item = screen.getByRole('menuitem');
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(onActivate).not.toHaveBeenCalled();
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('tabIndex', '-1');
  });
});
