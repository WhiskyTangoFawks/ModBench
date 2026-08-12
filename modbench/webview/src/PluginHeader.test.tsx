import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PluginHeader } from './PluginHeader';
import type { RecordDetail } from './types';

function override(partial: Partial<RecordDetail> = {}): RecordDetail {
  return {
    formKey: '000001:MyMod.esp', plugin: 'MyMod.esp', loadOrderIndex: 1,
    isWinner: true, editorId: 'TestNPC', fields: [], origin: 'Data',
    ...partial,
  };
}

function baseProps() {
  return {
    override: override(),
    isImmutable: false,
    collapsed: false,
    onToggleCollapse: vi.fn(),
  };
}

describe('PluginHeader', () => {
  it('shows the plugin name, load order index and winner marker', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.getByText('MyMod.esp')).toBeInTheDocument();
    expect(screen.getByText('[1] ✓ winner')).toBeInTheDocument();
  });

  it('clicking the plugin name toggles collapse', () => {
    const onToggleCollapse = vi.fn();
    render(<PluginHeader {...baseProps()} onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByText('MyMod.esp'));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('collapsed: hides load-order/winner line', () => {
    render(<PluginHeader {...baseProps()} collapsed={true} />);
    expect(screen.queryByText('[1] ✓ winner')).not.toBeInTheDocument();
  });

  it('shows "(read-only)" for an immutable column', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} />);
    expect(screen.getByText('(read-only)')).toBeInTheDocument();
  });

  // Issue #176: the standalone button is retired in favor of the "Copy as Override…" item on
  // the record grid's right-click context menu.
  it('does not render a Copy as Override… button', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.queryByText('Copy as Override…')).not.toBeInTheDocument();
  });

  // Issue #209: Add Master… moved into the column header's native right-click menu (ADR-0033:
  // no standalone control once an action is right-click-reachable) — PluginHeader no longer
  // renders a button or its own candidate dropdown for it.
  it('does not render an Add Master… button', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
  });
});
