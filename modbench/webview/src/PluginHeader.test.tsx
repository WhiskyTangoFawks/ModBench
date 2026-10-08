import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { PluginHeader } from './PluginHeader';
import { headerCellContext } from './recordUtils';
import type { CompareOverride } from './types';
import { compareOverride, required } from './test/fixtures';

const DIAGNOSIS = 'the PERK entry point did not have expected parameter type flag';

type Facts = { override?: Partial<CompareOverride>; notActive?: boolean; isImmutable?: boolean; isTracked?: boolean; sourceUnreadable?: boolean };

function renderHeader(facts: Facts = {}, props: Partial<React.ComponentProps<typeof PluginHeader>> = {}) {
  const onToggleCollapse = vi.fn();
  const onResize = vi.fn();
  render(
    <table><thead><tr>
      <PluginHeader
        override={compareOverride({
          formKey: '000001:MyMod.esp', plugin: 'MyMod.esp', origin: 'ModA', loadIndex: '01', fields: [], ...facts.override,
        })}
        notActive={facts.notActive ?? false}
        isImmutable={facts.isImmutable ?? false}
        isTracked={facts.isTracked ?? true}
        sourceUnreadable={facts.sourceUnreadable ?? false}
        isFile={false}
        onOpen={vi.fn()}
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

describe('PluginHeader', () => {
  afterEach(() => new Promise(resolve => setTimeout(resolve, 0)));

  it('labels the column `[XX] File name`, and says nothing of the winner', () => {
    const { header } = renderHeader();
    expect(screen.getByText('MyMod.esp').parentElement).toHaveTextContent(/^\[01\] MyMod\.esp$/);
    expect(header).not.toHaveTextContent(/winner/);
  });

  it('shows no origin on an expanded column, the origin sitting in the tooltip alone', () => {
    const { header } = renderHeader();
    expect(header).not.toHaveTextContent('ModA');
  });

  it.each<[string, Facts, string, string]>([
    ['a copy mEdit could not read', { override: { parseDiagnosis: DIAGNOSIS } }, '(parse failure)', DIAGNOSIS],
    ['a file whose plugin is disabled, or in a disabled mod', { notActive: true }, '(not active)',
      'The game does not load it, so no other copy is compared.'],
    ['the game’s own plugin', { isImmutable: true }, '(read-only)', 'The game’s plugins are not edited.'],
    ['a plugin in Overwrite', { override: { isInOverwrite: true }, isTracked: false }, '(in Overwrite)',
      'Overwrite is not a mod, and a plugin moved into a mod can be tracked.'],
    ['a plugin that is not tracked', { isTracked: false }, '(untracked)',
      '“Track Mod…”, or “Decompile Plugin” in a tracked mod, in this header’s menu, makes it editable.'],
    ['a tracked plugin whose plugin source is unreadable', { sourceUnreadable: true }, '(plugin source unreadable)',
      'Its plugin source is missing or cannot be read, so its records are its plugin file’s. “Decompile Plugin”, in this header’s menu, makes it editable.'],
    ['a Partial Form copy', { override: { isPartialForm: true } }, '(Partial Form)',
      'The game ignores this copy’s own fields.'],
    ['a tracked plugin', {}, '(tracked)',
      'An edit lands in the mod’s working tree, for review in Source Control.'],
  ])('for %s, shows its status, and a tooltip of the file name, the origin and the reason', (_case, facts, status, reason) => {
    const { header } = renderHeader(facts);
    expect(header).toHaveTextContent(status);
    expect(header).toHaveAttribute('title', `MyMod.esp\nModA\n${reason}`);
  });

  it.each<[string, Facts, string, string]>([
    ['parse failure over read-only', { override: { parseDiagnosis: DIAGNOSIS }, isImmutable: true }, '(parse failure)', '(read-only)'],
    ['parse failure over not active', { override: { parseDiagnosis: DIAGNOSIS }, notActive: true }, '(parse failure)', '(not active)'],
    ['not active over read-only', { notActive: true, isImmutable: true }, '(not active)', '(read-only)'],
    ['read-only over in Overwrite', { override: { isInOverwrite: true }, isImmutable: true }, '(read-only)', '(in Overwrite)'],
    ['in Overwrite over untracked', { override: { isInOverwrite: true }, isTracked: false }, '(in Overwrite)', '(untracked)'],
    ['untracked over Partial Form', { override: { isPartialForm: true }, isTracked: false }, '(untracked)', '(Partial Form)'],
    ['untracked over unreadable', { isTracked: false, sourceUnreadable: true }, '(untracked)', '(plugin source unreadable)'],
    ['unreadable over Partial Form', { override: { isPartialForm: true }, sourceUnreadable: true }, '(plugin source unreadable)', '(Partial Form)'],
    ['Partial Form over tracked', { override: { isPartialForm: true } }, '(Partial Form)', '(tracked)'],
  ])('a column shows one status, the first that applies: %s', (_case, facts, shown, displaced) => {
    const { header } = renderHeader(facts);
    expect(header).toHaveTextContent(shown);
    expect(header).not.toHaveTextContent(displaced);
  });

  it('holds no control but the collapse button, so nothing writes the Partial Form flag from here, even on a Partial Form column', () => {
    const { header } = renderHeader({ override: { isPartialForm: true } });
    expect(header.querySelectorAll('input, select')).toHaveLength(0);
    expect(header.querySelectorAll('button')).toHaveLength(1);
  });

  it('toggles its column’s collapse from its button', () => {
    const { header, onToggleCollapse } = renderHeader();
    fireEvent.click(within(header).getByRole('button'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('toggles nothing on a click elsewhere on it', () => {
    const { header, onToggleCollapse } = renderHeader();
    fireEvent.click(header);
    fireEvent.click(screen.getByText('MyMod.esp'));
    fireEvent.click(screen.getByText('(tracked)'));
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it('shows its button as a restore control while collapsed', () => {
    const { header } = renderHeader({}, { collapsed: true });
    expect(within(header).getByRole('button')).toHaveTextContent('▶');
  });

  it('shows only its label while collapsed', () => {
    renderHeader({}, { collapsed: true });
    expect(screen.queryByText('(tracked)')).not.toBeInTheDocument();
    expect(screen.getByText('MyMod.esp').parentElement).toHaveTextContent(/^\[01\] MyMod\.esp$/);
  });

  it('resizes its column by the drag of its edge, and does not collapse it', () => {
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

  it('carries on the whole header cell the data-vscode-context payload its native right-click menu gates the copy commands on', () => {
    const vscodeContext = JSON.stringify(headerCellContext('000001:MyMod.esp', 'MyMod.esp', 'ModA', { compilable: false, editable: false, inMod: 'none' }));
    const { header } = renderHeader({}, { vscodeContext });
    expect(header).toHaveAttribute('data-vscode-context', vscodeContext);
  });
});
