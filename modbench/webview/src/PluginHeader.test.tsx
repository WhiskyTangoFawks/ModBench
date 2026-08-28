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
    ...partial,
  };
}

function baseProps() {
  return {
    override: override(),
    isImmutable: false,
    inLoadOrder: true,
    // #415: tracked by default, so every pre-existing case here keeps describing an editable
    // column exactly as it did — the untracked cases opt in explicitly below.
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
  // distinction to be visible, not only discoverable on hover. "(not loaded)", not "(not in load
  // order)" — a shadowed copy is a file conflict, decided by the Mod override order, not the
  // Plugin load order this label would otherwise (wrongly) imply (CONTEXT-MAP.md).
  it('shows a distinct label for an immutable column the load order does not name', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    expect(screen.queryByText('(read-only)')).not.toBeInTheDocument();
    expect(screen.getByText('(not loaded)')).toBeInTheDocument();
  });

  // #304 review: pins the *meaning*, not just the vocabulary — a prior draft avoided "mod" and
  // "priority" while still asserting the wrong mechanism ("move it earlier in the load order",
  // which only ever fixes a Plugin-load-order-absent case, never a shadowed-file conflict, which
  // is decided by the Mod override order instead — CONTEXT-MAP.md, CONTEXT.md:37-49). An exact
  // match means any future rewording is a deliberate, reviewed choice, not a silent drift back to
  // something false that happens to still dodge two banned words.
  it('the not-loaded tooltip is exactly the reviewed, true-for-both-causes wording', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    expect(screen.getByText('(not loaded)')).toHaveAttribute(
      'title',
      'This copy plays no part in what the game actually loads, so editing it here changes '
      + 'nothing anywhere. Whether this file loads, and which copy, is decided in the Mods and '
      + 'Plugins views.',
    );
  });

  // Still checked as a floor, independent of the exact-match test above: whatever the wording is,
  // it must never reintroduce Mod Management's vocabulary as a common noun/mechanism ("this mod",
  // "raise its priority") — distinct from naming the actual "Mods"/"Plugins" view titles, which is
  // naming a surface, not importing a bounded context's model.
  it('the not-loaded tooltip never uses "mod" as a common noun or "priority" as a mechanism', () => {
    render(<PluginHeader {...baseProps()} isImmutable={true} inLoadOrder={false} />);
    const title = screen.getByText('(not loaded)').getAttribute('title') ?? '';
    expect(title).not.toMatch(/\bmod\b/i);
    expect(title).not.toMatch(/priority/i);
  });

  // #304 review: dimming is applied exactly once, by RecordPanel's own <th> — PluginHeader must
  // not also dim its own root, or the two compound (CSS opacity multiplies on nesting: 0.55 twice
  // renders at ~0.30). Renders the actual nesting (a <th> wrapping <PluginHeader>, mirroring
  // RecordPanel's real markup) so this can't silently return.
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

  // Issue #176/#494: the standalone button is retired in favor of "Copy as Override Into…"/"Copy
  // as New Record Into…" on the header's own native right-click menu — there is no rendered
  // button to assert on (ADR-0027/0033), so this pins the `data-vscode-context` payload
  // `contributes.menus["webview/context"]` gates those commands on instead.
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

  // Issue #209: Add Master… moved into the column header's native right-click menu (ADR-0034:
  // no standalone control once an action is right-click-reachable) — PluginHeader no longer
  // renders a button or its own candidate dropdown for it.
  it('does not render an Add Master… button', () => {
    render(<PluginHeader {...baseProps()} />);
    expect(screen.queryByText('Add Master…')).not.toBeInTheDocument();
  });
});

// #415 AC4 / ADR-0041 (User Story 2): "an untracked plugin is visibly read-only with the way out
// named". Visibly, i.e. before the user attempts an edit and is refused — which is why this lives
// on the column header rather than only in the refusal the backend returns.
describe('PluginHeader — untracked signposting (#415)', () => {
  it('marks an untracked column read-only on screen, not only in a tooltip', () => {
    render(<PluginHeader {...baseProps()} isTracked={false} />);

    expect(screen.getByText('(untracked)')).toBeTruthy();
  });

  // Asserted as the exact palette entry, not as "contains Track": package.json contributes the
  // title "Track\u2026" under category "Modbench", and a signpost naming a command that does not
  // exist verbatim is the dead end AC4 exists to prevent. A rename now breaks this test instead of
  // the signpost.
  it('names the Track command exactly as the palette shows it', () => {
    render(<PluginHeader {...baseProps()} isTracked={false} />);

    expect(screen.getByTitle(/Modbench: Track\u2026/)).toBeTruthy();
  });

  it('signposts the patch-plugin path instead for a master that cannot be tracked at all', () => {
    // The other half of AC4: Track does not apply to a vanilla or DLC master, so its signposting
    // must not name it. Offering a command that cannot work here is the dead end the AC forbids.
    render(<PluginHeader {...baseProps()} isImmutable isTracked={false} />);

    const title = screen.getByTitle(/patch/i);
    expect(title).toBeTruthy();
    expect(title.getAttribute('title')).not.toMatch(/Track/);
    expect(title.getAttribute('title')).not.toMatch(/Modbench: Track\u2026/);
  });

  it('says nothing at all once the mod is tracked', () => {
    render(<PluginHeader {...baseProps()} isTracked />);

    expect(screen.queryByText('(untracked)')).toBeNull();
    expect(screen.queryByText('(read-only)')).toBeNull();
  });
});

// #539: the header-write half of #491's Partial Form work — a checkbox on a partial-formable
// column's own header, reflecting isPartialForm and dispatching the sanctioned is_partial_form
// write on toggle.
describe('PluginHeader — Partial Form toggle (#539)', () => {
  it('does not render the toggle for a column whose record type can never carry the flag', () => {
    render(<PluginHeader {...baseProps()} override={override({ isPartialFormable: false })} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  // Rival: a version that renders whenever isPartialForm is merely defined (rather than gating on
  // isPartialFormable) would render here too, since isPartialForm is explicitly false, not absent.
  it('does not render the toggle when isPartialFormable is absent, even if isPartialForm is set', () => {
    render(<PluginHeader {...baseProps()} override={override({ isPartialForm: false })} />);

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
