import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PluginHeader } from './PluginHeader';
import { headerCellContext, combineVscodeContexts } from './recordUtils';
import type { CompareOverride } from './types';
import { compareOverride, required } from './test/fixtures';

const DIAGNOSIS = 'the PERK entry point did not have expected parameter type flag';

type Facts = { override?: Partial<CompareOverride>; isImmutable?: boolean; isTracked?: boolean };

function renderHeader(facts: Facts = {}, props: Partial<React.ComponentProps<typeof PluginHeader>> = {}) {
  const onToggleCollapse = vi.fn();
  const onResize = vi.fn();
  render(
    <table><thead><tr>
      <PluginHeader
        override={compareOverride({
          formKey: '000001:MyMod.esp', plugin: 'MyMod.esp', origin: 'ModA', loadIndex: '01', fields: [], ...facts.override,
        })}
        isImmutable={facts.isImmutable ?? false}
        isTracked={facts.isTracked ?? true}
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
        onResize={onResize}
        style={{}}
        {...props}
      />
    </tr></thead></table>,
  );
  const header = required(screen.getByText('MyMod.esp').closest('th'), 'the header cell');
  return { header, onToggleCollapse, onResize };
}

// editor.md, A column's header.
describe('PluginHeader', () => {
  it('labels the column `[XX] File name`, and says nothing of the winner', () => {
    const { header } = renderHeader();
    expect(screen.getByText('MyMod.esp').parentElement).toHaveTextContent(/^\[01\] MyMod\.esp$/);
    expect(header).not.toHaveTextContent(/winner/);
  });

  // ADR-0012, invariant 3: the origin sits in the tooltip alone.
  it('shows no origin on an expanded column', () => {
    const { header } = renderHeader();
    expect(header).not.toHaveTextContent('ModA');
  });

  // The Status table, its "When" and "The tooltip says" columns; the Tooltip row.
  it.each<[string, Facts, string, string]>([
    ['a copy mEdit could not read', { override: { parseDiagnosis: DIAGNOSIS } }, '(parse failure)', DIAGNOSIS],
    ['the game’s own plugin', { isImmutable: true }, '(read-only)', 'The game’s plugins are not edited.'],
    ['a plugin in Overwrite', { override: { isInOverwrite: true }, isTracked: false }, '(in Overwrite)',
      'Overwrite is not a mod, and a plugin moved into a mod can be tracked.'],
    ['a plugin that is not tracked', { isTracked: false }, '(untracked)',
      '“Track Mod…”, or “Decompile Plugin” in a tracked mod, in this header’s menu, makes it editable.'],
    ['a Partial Form copy', { override: { isPartialForm: true } }, '(Partial Form)',
      'The game ignores this copy’s own fields.'],
    ['a tracked plugin', {}, '(tracked)',
      'An edit lands in the mod’s working tree, for review in Source Control.'],
  ])('for %s, shows its status, and a tooltip of the file name, the origin and the reason', (_case, facts, status, reason) => {
    const { header } = renderHeader(facts);
    expect(header).toHaveTextContent(status);
    expect(header).toHaveAttribute('title', `MyMod.esp\nModA\n${reason}`);
  });

  // "A column shows one status, the first in this table that applies."
  it.each<[string, Facts, string, string]>([
    ['parse failure over read-only', { override: { parseDiagnosis: DIAGNOSIS }, isImmutable: true }, '(parse failure)', '(read-only)'],
    ['read-only over in Overwrite', { override: { isInOverwrite: true }, isImmutable: true }, '(read-only)', '(in Overwrite)'],
    ['in Overwrite over untracked', { override: { isInOverwrite: true }, isTracked: false }, '(in Overwrite)', '(untracked)'],
    ['untracked over Partial Form', { override: { isPartialForm: true }, isTracked: false }, '(untracked)', '(Partial Form)'],
    ['Partial Form over tracked', { override: { isPartialForm: true } }, '(Partial Form)', '(tracked)'],
  ])('shows %s', (_case, facts, shown, displaced) => {
    const { header } = renderHeader(facts);
    expect(header).toHaveTextContent(shown);
    expect(header).not.toHaveTextContent(displaced);
  });

  // editor.md, The header... "It holds no controls"; a column's header holds none either, so
  // nothing writes the Partial Form flag from here.
  it('holds no control, not even on a Partial Form column', () => {
    const { header } = renderHeader({ override: { isPartialForm: true } });
    expect(header.querySelector('input, button, select')).toBeNull();
  });

  // Columns, story 3.
  it('toggles its column’s collapse on a click anywhere on it', () => {
    const { header, onToggleCollapse } = renderHeader();
    fireEvent.click(header);
    fireEvent.click(screen.getByText('(tracked)'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
  });

  it('shows only its label while collapsed', () => {
    const { header } = renderHeader({}, { collapsed: true });
    expect(header).toHaveTextContent(/^\[01\] MyMod\.esp$/);
  });

  // Columns, story 5.
  it('resizes its column by the drag of its edge, and does not collapse it', async () => {
    const { header, onToggleCollapse, onResize } = renderHeader();
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 20));
    const edge = required(header.querySelector('[data-column-edge]'), 'the header’s edge');

    fireEvent.mouseDown(edge, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 360 });
    fireEvent.mouseUp(window, { clientX: 360 });
    fireEvent.click(header);
    fireEvent.mouseMove(window, { clientX: 400 });

    expect(onResize.mock.calls).toEqual([[260]]);
    expect(onToggleCollapse).not.toHaveBeenCalled();

    await new Promise(resolve => setTimeout(resolve, 0));
    fireEvent.click(header);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('takes no drag from a button but the left one', () => {
    const { header, onResize } = renderHeader();
    const edge = required(header.querySelector('[data-column-edge]'), 'the header’s edge');

    fireEvent.mouseDown(edge, { clientX: 300, button: 2 });
    fireEvent.mouseMove(window, { clientX: 360 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it('offers no edge to drag while collapsed', () => {
    const { header } = renderHeader({}, { collapsed: true });
    expect(header.querySelector('[data-column-edge]')).toBeNull();
  });

  // The copy commands live on the header's native right-click menu, so the only thing to assert is
  // the `data-vscode-context` payload they are gated on, anywhere a right click lands.
  it('carries the context its menu reads on the whole header cell', () => {
    const vscodeContext = combineVscodeContexts(headerCellContext('000001:MyMod.esp', 'MyMod.esp', 'ModA', false));
    const { header } = renderHeader({}, { vscodeContext });
    expect(header).toHaveAttribute('data-vscode-context', vscodeContext);
  });
});
