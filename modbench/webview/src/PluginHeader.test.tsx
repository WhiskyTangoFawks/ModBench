import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PluginHeader } from './PluginHeader';
import type { RecordDetail } from './types';
import type { PluginInfo } from './RecordSessionClient';

function override(partial: Partial<RecordDetail> = {}): RecordDetail {
  return {
    formKey: '000001:MyMod.esp', plugin: 'MyMod.esp', loadOrderIndex: 1,
    isWinner: true, editorId: 'TestNPC', fields: [],
    ...partial,
  };
}

const basePlugins: PluginInfo[] = [
  { name: 'Fallout4.esm', isImmutable: true, loadOrderIndex: 0 },
  { name: 'MyMod.esp', isImmutable: false, loadOrderIndex: 1 },
  { name: 'Other.esp', isImmutable: false, loadOrderIndex: 2 },
];

function baseProps() {
  return {
    override: override(),
    isImmutable: false,
    isHeaderRecord: false,
    showMasterPicker: false,
    loadedPlugins: basePlugins,
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onOpenMasterPicker: vi.fn(),
    onCloseMasterPicker: vi.fn(),
    onAddMaster: vi.fn(),
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
  // the record grid's right-click context menu (ColumnHeaderMenu/RecordPanel).
  it('does not render a Copy as Override… button', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.queryByText('Copy as Override…')).not.toBeInTheDocument();
  });

  it('mutable, non-header-record column shows no structural action buttons', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
  });

  it('header record: shows Add Master… and lists candidates excluding self and current masters', () => {
    const headerOverride = override({
      formKey: '000000:MyMod.esp',
      fields: [{ metadata: { name: 'masters', type: 'string', isArray: true, validFormKeyTypes: [], enumValues: [] }, value: ['Fallout4.esm'] }],
    });
    render(<PluginHeader {...baseProps()} override={headerOverride} isHeaderRecord={true} showMasterPicker={true} />);
    expect(screen.getByText('Add Master…')).toBeInTheDocument();
    // Fallout4.esm is already a master, MyMod.esp is self — only Other.esp is a candidate.
    expect(screen.getByText('Other.esp')).toBeInTheDocument();
    expect(screen.queryByText('Fallout4.esm')).not.toBeInTheDocument();
  });

  it('selecting an Add Master candidate calls onAddMaster with the appended list', () => {
    const onAddMaster = vi.fn();
    const headerOverride = override({
      formKey: '000000:MyMod.esp',
      fields: [{ metadata: { name: 'masters', type: 'string', isArray: true, validFormKeyTypes: [], enumValues: [] }, value: ['Fallout4.esm'] }],
    });
    render(<PluginHeader {...baseProps()} override={headerOverride} isHeaderRecord={true} showMasterPicker={true} onAddMaster={onAddMaster} />);
    fireEvent.mouseDown(screen.getByText('Other.esp'));
    expect(onAddMaster).toHaveBeenCalledWith(['Fallout4.esm', 'Other.esp']);
  });
});
