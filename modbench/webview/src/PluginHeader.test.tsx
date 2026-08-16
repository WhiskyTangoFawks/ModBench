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
    inLoadOrder: true,
    showOriginInline: false,
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

  // #304: a vanilla/DLC/CC master — immutable, still named by the load order — keeps the plain,
  // familiar "(read-only)" label; its tooltip names the reason, distinct from a shadowed copy's.
  it('shows "(read-only)" for an immutable, in-load-order column (a vanilla master)', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={true} />);
    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    expect(screen.getByText('(read-only)')).toHaveAttribute(
      'title', expect.stringMatching(/vanilla/i),
    );
  });

  // #304 / ADR-0036: a copy the load order does not name reads differently on screen (not just
  // in the tooltip) — same underlying fact (immutable) but a distinct cause, and AC2 asks for the
  // distinction to be visible, not only discoverable on hover.
  it('shows a distinct label for an immutable column the load order does not name', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
    expect(screen.getByText('(not in load order)')).toBeInTheDocument();
  });

  // AC2: the tooltip names the escape hatch (ADR-0036) — raising this copy to the one that
  // loads makes it editable. Never "mod"/"priority" (CONTEXT-MAP.md's Editing/Mod Management
  // vocabulary boundary — Editing says "load order", not "priority").
  it('the not-in-load-order tooltip names the escape hatch, without Mod Management vocabulary', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    const title = screen.getByText('(not in load order)').getAttribute('title') ?? '';
    expect(title).toMatch(/load order/i);
    expect(title).toMatch(/editable/i);
    expect(title).not.toMatch(/\bmod\b/i);
    expect(title).not.toMatch(/priority/i);
  });

  // #304 / ADR-0035: dimming keys on inLoadOrder, not isImmutable — a vanilla master must not
  // dim (it participates normally; it just can't be edited), only a copy the load order doesn't
  // name, matching the tree row's own treatment for the identical reason (ADR-0035).
  it('renders dimmed only when the column is not in the load order', () => {
    const { container: dimmed } = render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    const { container: vanilla } = render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={true} />);
    const { container: mutable } = render(<PluginHeader {...baseProps()} isImmutable={false} inLoadOrder={true} />);
    expect((dimmed.firstElementChild as HTMLElement).style.opacity).not.toBe('');
    expect((vanilla.firstElementChild as HTMLElement).style.opacity).toBe('');
    expect((mutable.firstElementChild as HTMLElement).style.opacity).toBe('');
  });

  // ADR-0036: origin is never what the user reads by default — only the filename.
  it('does not render origin inline when there is no collision', () => {
    render(<PluginHeader {...baseProps()} override={override({ origin: 'ModA' })} showOriginInline={false} />);
    expect(screen.getByText('MyMod.esp')).toBeInTheDocument();
    expect(screen.queryByText(/ModA/)).not.toBeInTheDocument();
  });

  // ADR-0036: "origin appears inline only when two loaded copies share a filename."
  it('renders origin inline when showOriginInline is true', () => {
    render(<PluginHeader {...baseProps()} override={override({ origin: 'ModA' })} showOriginInline={true} />);
    expect(screen.getByText('MyMod.esp (ModA)')).toBeInTheDocument();
  });

  // ADR-0036: "filename in the header, origin in its tooltip" — unconditionally, so a
  // non-colliding column still tells a curious user which origin it's from on hover.
  it('always sets the origin in a tooltip on the name chip, regardless of collision', () => {
    render(<PluginHeader {...baseProps()} override={override({ origin: 'ModA' })} showOriginInline={false} />);
    expect(screen.getByText('MyMod.esp')).toHaveAttribute('title', expect.stringContaining('ModA'));
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
