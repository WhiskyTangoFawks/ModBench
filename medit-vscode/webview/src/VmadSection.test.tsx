import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { VmadSection } from './VmadSection';
import type { Column } from './recordUtils';
import type { CompareOverride, VmadCompare, VmadScriptDiff, VmadPropertyDiff } from './types';

// ── fixtures ──────────────────────────────────────────────────────────────────

function override(plugin: string): CompareOverride {
  return {
    formKey: `000800:${plugin}`,
    plugin,
    loadOrderIndex: 0,
    isWinner: false,
    editorId: null,
    fields: [],
    conflictThis: 'Master',
  };
}

const diskCols = (plugins: string[]): Column[] =>
  plugins.map(p => ({ kind: 'disk', override: override(p) }));

function script(partial: Partial<VmadScriptDiff> & Pick<VmadScriptDiff, 'name'>): VmadScriptDiff {
  return {
    flags: {},
    winnerPlugin: 'B.esp',
    cellStates: {},
    properties: [],
    ...partial,
  };
}

function prop(partial: Partial<VmadPropertyDiff> & Pick<VmadPropertyDiff, 'name' | 'kind'>): VmadPropertyDiff {
  return {
    values: {},
    types: {},
    winnerPlugin: 'B.esp',
    cellStates: {},
    children: null,
    ...partial,
  };
}

function renderSection(vmad: VmadCompare | null, plugins: string[], onOpen = vi.fn()) {
  const cols = diskCols(plugins);
  const utils = render(
    <table>
      <tbody>
        <VmadSection vmad={vmad} columns={cols} onOpen={onOpen} />
      </tbody>
    </table>,
  );
  return { ...utils, onOpen };
}

function toggle(label: string) {
  const btn = screen.getByText(label).closest('tr')!.querySelector('button')!;
  fireEvent.click(btn);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('VmadSection', () => {
  it('renders a script-name row and, when expanded, its property sub-rows', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'MyScript',
        flags: { 'A.esm': 'Local', 'B.esp': 'Local' },
        properties: [prop({ name: 'Enabled', kind: 'scalar', values: { 'A.esm': true, 'B.esp': true } })],
      })],
    };
    renderSection(vmad, ['A.esm', 'B.esp']);

    expect(screen.getByText('Scripts (VMAD)')).toBeInTheDocument();
    expect(screen.getByText('MyScript')).toBeInTheDocument();
    // properties hidden until expanded
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();

    toggle('MyScript');
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('renders an Object property FormKey as a link with the alias, opening it on click', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Target',
          kind: 'object',
          values: { 'A.esm': '000123:Foo.esp [2]' },
          types: { 'A.esm': 'Object' },
        })],
      })],
    };
    const { onOpen } = renderSection(vmad, ['A.esm']);
    toggle('S');

    const link = screen.getByText('000123:Foo.esp');
    expect(link.tagName).toBe('BUTTON');
    expect(screen.getByText(/\[2\]/)).toBeInTheDocument();

    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith('000123:Foo.esp');
  });

  it('renders a scalar-array property as [N items] and expands to N element rows', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Items',
          kind: 'array',
          children: [
            prop({ name: '[0]', kind: 'scalar', values: { 'A.esm': 10 } }),
            prop({ name: '[1]', kind: 'scalar', values: { 'A.esm': 20 } }),
          ],
        })],
      })],
    };
    renderSection(vmad, ['A.esm']);
    toggle('S');

    expect(screen.getByText('[2 items]')).toBeInTheDocument();
    expect(screen.queryByText('[0]')).not.toBeInTheDocument();

    toggle('Items');
    expect(screen.getByText('[0]')).toBeInTheDocument();
    expect(screen.getByText('[1]')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('expands a Struct property into its member rows', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Bounds',
          kind: 'struct',
          children: [
            prop({ name: 'X', kind: 'scalar', values: { 'A.esm': 1 } }),
            prop({ name: 'Y', kind: 'scalar', values: { 'A.esm': 2 } }),
          ],
        })],
      })],
    };
    renderSection(vmad, ['A.esm']);
    toggle('S');
    expect(screen.queryByText('X')).not.toBeInTheDocument();

    toggle('Bounds');
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(screen.getByText('Y')).toBeInTheDocument();
  });

  it('colors a conflicted property cell and leaves an equal cell uncolored', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        cellStates: { 'A.esm': 'Master', 'B.esp': 'ConflictLoses' },
        properties: [prop({
          name: 'Enabled',
          kind: 'scalar',
          values: { 'A.esm': 'true', 'B.esp': 'false' },
          cellStates: { 'A.esm': 'Master', 'B.esp': 'ConflictLoses' },
        })],
      })],
    };
    renderSection(vmad, ['A.esm', 'B.esp']);
    toggle('S');

    const conflicted = screen.getByText('false').closest('td')!;
    expect(conflicted.style.backgroundColor).toBe('rgba(244, 67, 54, 0.18)');
    expect(conflicted.style.color).toBe('rgba(244, 67, 54, 1)');

    const equal = screen.getByText('true').closest('td')!;
    expect(equal.style.backgroundColor).toBe('');
  });

  it('renders nothing when vmad is null', () => {
    const { container } = renderSection(null, ['A.esm']);
    expect(container.querySelector('tr')).toBeNull();
    expect(screen.queryByText('Scripts (VMAD)')).not.toBeInTheDocument();
  });

  it('renders nothing when vmad has no scripts', () => {
    const { container } = renderSection({ scripts: [] }, ['A.esm']);
    expect(container.querySelector('tr')).toBeNull();
  });

  it('renders no edit inputs (read-only invariant) while keeping conflict coloring', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        cellStates: { 'B.esp': 'ConflictLoses' },
        properties: [prop({
          name: 'Enabled',
          kind: 'scalar',
          values: { 'A.esm': 'true', 'B.esp': 'false' },
          cellStates: { 'B.esp': 'ConflictLoses' },
        })],
      })],
    };
    const { container } = renderSection(vmad, ['A.esm', 'B.esp']);
    toggle('S');

    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(screen.getByText('false').closest('td')!.style.backgroundColor).toBe('rgba(244, 67, 54, 0.18)');
  });
});
