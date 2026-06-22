import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { VmadSection } from './VmadSection';
import type { Column } from './recordUtils';
import type { CompareOverride, PendingChange, VmadCompare, VmadScriptDiff, VmadPropertyDiff } from './types';

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

function pendingChange(plugin: string, fieldPath: string, newValue: unknown): PendingChange {
  return {
    id: `chg:${plugin}:${fieldPath}`,
    formKey: `000800:${plugin}`,
    plugin,
    fieldPath,
    recordType: 'NPC_',
    oldValue: null,
    newValue,
    source: 'user',
    description: null,
    changedAt: '2026-01-01T00:00:00Z',
  };
}

type RenderOpts = {
  onOpen?: ReturnType<typeof vi.fn>;
  editMode?: boolean;
  onEdit?: ReturnType<typeof vi.fn>;
  onRevert?: ReturnType<typeof vi.fn>;
  pendingChangeMap?: Record<string, PendingChange>;
  withPendingCol?: string; // plugin to add a pending column for
};

function renderSection(vmad: VmadCompare | null, plugins: string[], opts: RenderOpts = {}) {
  const onOpen = opts.onOpen ?? vi.fn();
  const cols: Column[] = plugins.flatMap(p => {
    const dc: Column = { kind: 'disk', override: override(p) };
    return opts.withPendingCol === p ? [dc, { kind: 'pending', plugin: p }] : [dc];
  });
  const utils = render(
    <table>
      <tbody>
        <VmadSection
          vmad={vmad}
          columns={cols}
          onOpen={onOpen}
          editMode={opts.editMode}
          onEdit={opts.onEdit}
          onRevert={opts.onRevert}
          pendingChangeMap={opts.pendingChangeMap}
          port={5172}
        />
      </tbody>
    </table>,
  );
  return { ...utils, onOpen };
}

function toggle(label: string) {
  const btn = screen.getByText(label).closest('tr')!.querySelector('button')!;
  fireEvent.click(btn);
}

// ── read-only display (13.3) ───────────────────────────────────────────────────

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

// ── edit mode (13.5) ──────────────────────────────────────────────────────────

const boolVmad = (): VmadCompare => ({
  scripts: [script({
    name: 'MyScript',
    properties: [prop({
      name: 'Enabled',
      kind: 'scalar',
      values: { 'A.esm': false },
      types: { 'A.esm': 'Bool' },
      winnerPlugin: 'A.esm',
    })],
  })],
});

describe('VmadSection edit mode', () => {
  it('Bool property renders a checkbox in edit mode', () => {
    const { container } = renderSection(boolVmad(), ['A.esm'], { editMode: true, onEdit: vi.fn() });
    toggle('MyScript');

    expect(container.querySelector('input[type="checkbox"]')).toBeInTheDocument();
  });

  it('toggling Bool checkbox calls onEdit with VMAD path and boolean value', () => {
    const onEdit = vi.fn();
    renderSection(boolVmad(), ['A.esm'], { editMode: true, onEdit });
    toggle('MyScript');

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onEdit).toHaveBeenCalledWith('A.esm', 'VMAD\\MyScript\\Enabled', true);
  });

  it('Int property edit stages VMAD path with numeric value', () => {
    const onEdit = vi.fn();
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Count',
          kind: 'scalar',
          values: { 'A.esm': 5 },
          types: { 'A.esm': 'Int' },
          winnerPlugin: 'A.esm',
        })],
      })],
    };
    renderSection(vmad, ['A.esm'], { editMode: true, onEdit });
    toggle('S');

    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);

    expect(onEdit).toHaveBeenCalledWith('A.esm', 'VMAD\\S\\Count', 42);
  });

  it('String property edit stages VMAD path with string value', () => {
    const onEdit = vi.fn();
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Name',
          kind: 'scalar',
          values: { 'A.esm': 'old' },
          types: { 'A.esm': 'String' },
          winnerPlugin: 'A.esm',
        })],
      })],
    };
    renderSection(vmad, ['A.esm'], { editMode: true, onEdit });
    toggle('S');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.blur(input);

    expect(onEdit).toHaveBeenCalledWith('A.esm', 'VMAD\\S\\Name', 'new');
  });

  it('Object property renders FK button and alias input in edit mode', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Target',
          kind: 'object',
          values: { 'A.esm': '000123:Foo.esp [2]' },
          types: { 'A.esm': 'Object' },
          winnerPlugin: 'A.esm',
        })],
      })],
    };
    const { container } = renderSection(vmad, ['A.esm'], { editMode: true, onEdit: vi.fn() });
    toggle('S');

    expect(container.querySelector('input[type="number"][aria-label="Alias"]')).toBeInTheDocument();
    expect((container.querySelector('input[type="number"][aria-label="Alias"]') as HTMLInputElement).value).toBe('2');
  });

  it('Object alias change + blur stages VMAD path with { formKey, alias }', () => {
    const onEdit = vi.fn();
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({
          name: 'Target',
          kind: 'object',
          values: { 'A.esm': '000123:Foo.esp [2]' },
          types: { 'A.esm': 'Object' },
          winnerPlugin: 'A.esm',
        })],
      })],
    };
    renderSection(vmad, ['A.esm'], { editMode: true, onEdit });
    toggle('S');

    const aliasInput = screen.getByRole('spinbutton', { name: 'Alias' });
    fireEvent.change(aliasInput, { target: { value: '5' } });
    fireEvent.blur(aliasInput);

    expect(onEdit).toHaveBeenCalledWith('A.esm', 'VMAD\\S\\Target', { formKey: '000123:Foo.esp', alias: 5 });
  });

  it('pending VMAD change shows new value and revert button; clicking revert calls onRevert', () => {
    const onRevert = vi.fn();
    const chg = pendingChange('A.esm', 'VMAD\\MyScript\\Enabled', true);
    renderSection(boolVmad(), ['A.esm'], {
      editMode: true,
      onRevert,
      withPendingCol: 'A.esm',
      pendingChangeMap: { ['A.esm:VMAD\\MyScript\\Enabled']: chg },
    });
    toggle('MyScript');

    expect(screen.getByText('true')).toBeInTheDocument();
    const revertBtn = screen.getByTitle('Revert this change');
    expect(revertBtn).toBeInTheDocument();
    fireEvent.click(revertBtn);
    expect(onRevert).toHaveBeenCalledWith(chg.id);
  });

  it('Variable, array, and struct properties show no edit widget in edit mode', () => {
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [
          prop({ name: 'V', kind: 'variable', types: { 'A.esm': 'Variable' }, winnerPlugin: 'A.esm' }),
          prop({ name: 'Arr', kind: 'array', children: [], types: { 'A.esm': 'ArrayOfInt' }, winnerPlugin: 'A.esm' }),
          prop({
            name: 'St',
            kind: 'struct',
            children: [prop({ name: 'X', kind: 'scalar', values: { 'A.esm': 1 } })],
            types: { 'A.esm': 'Struct' },
            winnerPlugin: 'A.esm',
          }),
        ],
      })],
    };
    const { container } = renderSection(vmad, ['A.esm'], { editMode: true, onEdit: vi.fn() });
    toggle('S');

    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });
});
