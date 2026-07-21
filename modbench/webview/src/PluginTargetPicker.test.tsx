import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PluginTargetPicker } from './PluginTargetPicker';
import type { PluginInfo } from './RecordSessionClient';

const targets: PluginInfo[] = [
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1 },
  { name: 'Other.esp', isImmutable: false, loadOrderIndex: 2 },
];

describe('PluginTargetPicker', () => {
  it('lists every target plugin', () => {
    render(<PluginTargetPicker x={10} y={20} targets={targets} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByRole('menuitem', { name: 'MyMod.esp' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Other.esp' })).toBeInTheDocument();
  });

  it('shows a placeholder when there are no mutable plugins', () => {
    render(<PluginTargetPicker x={10} y={20} targets={[]} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByText('No mutable plugins')).toBeInTheDocument();
  });

  it('calls onSelect with the plugin name when an item is clicked', () => {
    const onSelect = vi.fn();
    render(<PluginTargetPicker x={10} y={20} targets={targets} onClose={vi.fn()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other.esp' }));
    expect(onSelect).toHaveBeenCalledWith('Other.esp');
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    render(<PluginTargetPicker x={10} y={20} targets={targets} onClose={onClose} onSelect={vi.fn()} />);
    fireEvent.click(window);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<PluginTargetPicker x={10} y={20} targets={targets} onClose={onClose} onSelect={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
