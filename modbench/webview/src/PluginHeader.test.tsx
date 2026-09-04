import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PluginHeader } from './PluginHeader';
import { headerCellContext, combineVscodeContexts } from './recordUtils';
import type { RecordDetail } from './types';

function override(partial: Partial<RecordDetail> = {}): RecordDetail {
  return {
    formKey: '000001:MyMod.esp', plugin: 'MyMod.esp', loadOrderIndex: 1,
    isWinner: true, editorId: 'TestNPC', fields: [], origin: 'Data',
    recordType: 'npc_', isPartialForm: false, isPartialFormable: false,
    ...partial,
  };
}

function baseProps() {
  return {
    override: override(),
    isImmutable: false,
    inLoadOrder: true,
    // Tracked by default; the untracked cases opt in explicitly.
    isTracked: true,
    showOriginInline: false,
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onTogglePartialForm: vi.fn(),
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

  // A vanilla/DLC/CC master — immutable, still named by the load order — keeps the plain,
  // familiar "(read-only)" label; its tooltip names the reason, distinct from a shadowed copy's.
  it('shows "(read-only)" for an immutable, in-load-order column (a vanilla master)', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={true} />);
    expect(screen.getByText('(read-only)')).toBeInTheDocument();
    expect(screen.getByText('(read-only)')).toHaveAttribute(
      'title', expect.stringMatching(/vanilla/i),
    );
  });

  // ADR-0036: "(not loaded)", not "(not in load order)" — a shadowed copy is a file conflict
  // decided by the Mod override order, not the Plugin load order the longer label would imply.
  it('shows a distinct label for an immutable column the load order does not name', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
    expect(screen.getByText('(not loaded)')).toBeInTheDocument();
  });

  // Pins the meaning, not just the vocabulary: a wording can dodge the banned words and still
  // assert the wrong mechanism. An exact match makes any rewording a reviewed choice.
  it('the not-loaded tooltip is exactly the reviewed, true-for-both-causes wording', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    expect(screen.getByText('(not loaded)')).toHaveAttribute(
      'title',
      'This copy plays no part in what the game actually loads, so editing it here changes '
      + 'nothing anywhere. Whether this file loads, and which copy, is decided in the Mods and '
      + 'Plugins views.',
    );
  });

  // A floor whatever the wording: never Mod Management's vocabulary as a common noun or
  // mechanism, as distinct from naming the "Mods"/"Plugins" view titles, which names a surface.
  it('the not-loaded tooltip never uses "mod" as a common noun or "priority" as a mechanism', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    const title = screen.getByText('(not loaded)').getAttribute('title') ?? '';
    expect(title).not.toMatch(/\bmod\b/i);
    expect(title).not.toMatch(/priority/i);
  });

  // CSS opacity multiplies on nesting (0.55 twice renders at ~0.30), so PluginHeader must not
  // dim its own root as well as the <th> that wraps it.
  it('does not dim its own root when nested in a dimmed header cell — dimming is the header cell\'s job alone', () => {
    const { container } = render(
      <table><thead><tr>
        <th style={{ opacity: 0.55 }}>
          <PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />
        </th>
      </tr></thead></table>,
    );
    const pluginHeaderRoot = container.querySelector('th > div');
    expect((pluginHeaderRoot as HTMLElement).style.opacity).toBe('');
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

  // The copy commands live on the header's native right-click menu (ADR-0027/0033), so there is
  // no rendered button to assert on — only the `data-vscode-context` payload they are gated on.
  it('carries the header cell\'s data-vscode-context, naming the column\'s record identity for the native Copy menu', () => {
    const vscodeContext = combineVscodeContexts(headerCellContext('000001:MyMod.esp', 'MyMod.esp', 'Data'));
    const { container } = render(<PluginHeader {...baseProps()} vscodeContext={vscodeContext} />);
    expect(JSON.parse(container.firstElementChild!.getAttribute('data-vscode-context')!)).toEqual({
      webviewSection: 'recordHeader', formKey: '000001:MyMod.esp', plugin: 'MyMod.esp', origin: 'Data',
      preventDefaultContextMenuItems: true,
    });
  });

  it('renders no data-vscode-context attribute at all when the caller supplies none', () => {
    const { container } = render(<PluginHeader {...baseProps()} />);
    expect(container.firstElementChild).not.toHaveAttribute('data-vscode-context');
  });

  // ADR-0034: no standalone control once an action is right-click-reachable — PluginHeader
  // renders no Add Master… button or candidate dropdown.
  it('does not render an Add Master… button', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
  });
});

// ADR-0041: an untracked plugin is visibly read-only with the way out named — visibly, before
// the user attempts an edit, so it lives on the header, not only in the backend's refusal.
describe('PluginHeader — untracked signposting (#415)', () => {
  it('marks an untracked column read-only on screen, not only in a tooltip', () => {
    render(<PluginHeader {...baseProps()} isTracked={false} />);

    expect(screen.getByText('(untracked)')).toBeTruthy();
  });

  // The exact palette entry, not "contains Track": a signpost naming a command that does not
  // exist verbatim is a dead end, so a rename must break this case instead.
  it('names the Track command exactly as the palette shows it', () => {
    render(<PluginHeader {...baseProps()} isTracked={false} />);

    expect(screen.getByTitle(/Modbench: Track\u2026/)).toBeTruthy();
  });

  it('signposts the patch-plugin path instead for a master that cannot be tracked at all', () => {
    // Track does not apply to a vanilla or DLC master, so its signposting
    // must not name it. Offering a command that cannot work here is a dead end.
    render(<PluginHeader {...baseProps()} isImmutable isTracked={false} />);

    const title = screen.getByTitle(/patch/i);
    expect(title).toBeTruthy();
    expect(title.getAttribute('title')).not.toMatch(/Track/);
    expect(title.getAttribute('title')).not.toMatch(/Modbench: Track\u2026/);
  });

  it('shows "(tracked)" once the mod is tracked, not silence', () => {
    render(<PluginHeader {...baseProps()} isTracked />);

    expect(screen.queryByText('(untracked)')).toBeNull();
    expect(screen.queryByText('(read-only)')).toBeNull();
    expect(screen.getByText('(tracked)')).toBeInTheDocument();
  });
});

describe('PluginHeader — Partial Form toggle (#539)', () => {
  it('does not render the toggle for a column whose record type can never carry the flag', () => {
    render(<PluginHeader {...baseProps()} override={override({ isPartialFormable: false })} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });


  it('renders the toggle, checked, for a currently-flagged partial-formable column', () => {
    render(<PluginHeader {...baseProps()} override={override({ isPartialFormable: true, isPartialForm: true })} />);

    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('renders the toggle, unchecked, for an eligible but currently-unflagged column', () => {
    render(<PluginHeader {...baseProps()} override={override({ isPartialFormable: true, isPartialForm: false })} />);

    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('dispatches onTogglePartialForm(false) when unchecking a flagged column', () => {
    const onTogglePartialForm = vi.fn();
    render(
      <PluginHeader
        {...baseProps()}
        override={override({ isPartialFormable: true, isPartialForm: true })}
        onTogglePartialForm={onTogglePartialForm}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox'));

    expect(onTogglePartialForm).toHaveBeenCalledWith(false);
  });

  it('dispatches onTogglePartialForm(true) when checking an unflagged eligible column', () => {
    const onTogglePartialForm = vi.fn();
    render(
      <PluginHeader
        {...baseProps()}
        override={override({ isPartialFormable: true, isPartialForm: false })}
        onTogglePartialForm={onTogglePartialForm}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox'));

    expect(onTogglePartialForm).toHaveBeenCalledWith(true);
  });

  it('disables the toggle on an untracked column — no dead control for a write that cannot land', () => {
    render(
      <PluginHeader
        {...baseProps()}
        override={override({ isPartialFormable: true, isPartialForm: true })}
        isTracked={false}
      />,
    );

    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('disables the toggle on a not-in-load-order column', () => {
    render(
      <PluginHeader
        {...baseProps()}
        override={override({ isPartialFormable: true, isPartialForm: true })}
        inLoadOrder={false}
      />,
    );

    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('does not render the toggle at all when the column is collapsed', () => {
    render(
      <PluginHeader
        {...baseProps()}
        override={override({ isPartialFormable: true, isPartialForm: true })}
        collapsed
      />,
    );

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
