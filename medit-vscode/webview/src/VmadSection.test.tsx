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
  onStructOp?: ReturnType<typeof vi.fn>;
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
          onStructOp={opts.onStructOp}
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

// ── array edit mode (13.6) ────────────────────────────────────────────────────

function arrayVmad(elementKind: 'scalar' | 'object', values: unknown[]): VmadCompare {
  return {
    scripts: [script({
      name: 'S',
      properties: [prop({
        name: 'Items',
        kind: 'array',
        types: { 'A.esm': elementKind === 'object' ? 'ArrayOfObject' : 'ArrayOfInt' },
        winnerPlugin: 'A.esm',
        children: values.map((v, i) => prop({
          name: `[${i}]`,
          kind: elementKind,
          values: { 'A.esm': v },
          types: { 'A.esm': elementKind === 'object' ? 'Object' : 'Int' },
          winnerPlugin: 'A.esm',
        })),
      })],
    })],
  };
}

describe('VmadSection array edit mode', () => {
  it('expanding an ArrayOfInt property in edit mode shows a number input per element', () => {
    const { container } = renderSection(arrayVmad('scalar', [10, 20]), ['A.esm'], {
      editMode: true,
      onEdit: vi.fn(),
    });
    toggle('S');
    toggle('Items');

    const inputs = container.querySelectorAll('input[type="number"]');
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).value).toBe('10');
    expect((inputs[1] as HTMLInputElement).value).toBe('20');
  });

  it('Add button appends a default element and stages the full new array', () => {
    const onEdit = vi.fn();
    renderSection(arrayVmad('scalar', [10, 20]), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Items');

    fireEvent.click(screen.getByTitle('Add element'));

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [10, 20, 0]);
  });

  it('Remove button on an element removes it and stages the remaining array', () => {
    const onEdit = vi.fn();
    renderSection(arrayVmad('scalar', [10, 20, 30]), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Items');

    fireEvent.click(screen.getAllByTitle('Remove element')[1]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [10, 30]);
  });

  it('Move down on an element swaps it with the next and stages the reordered array', () => {
    const onEdit = vi.fn();
    renderSection(arrayVmad('scalar', [10, 20, 30]), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Items');

    fireEvent.click(screen.getAllByTitle('Move down')[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [20, 10, 30]);
  });

  it('Move up on an element swaps it with the previous and stages the reordered array', () => {
    const onEdit = vi.fn();
    renderSection(arrayVmad('scalar', [10, 20, 30]), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Items');

    fireEvent.click(screen.getAllByTitle('Move up')[2]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [10, 30, 20]);
  });

  it('pending array change shows on the parent row pending column with revert button', () => {
    const onRevert = vi.fn();
    const chg = pendingChange('A.esm', String.raw`VMAD\S\Items`, [10, 20, 0]);
    renderSection(arrayVmad('scalar', [10, 20]), ['A.esm'], {
      editMode: true,
      onRevert,
      withPendingCol: 'A.esm',
      pendingChangeMap: { [String.raw`A.esm:VMAD\S\Items`]: chg },
    });
    toggle('S');

    // Pending column on the parent array row shows the new array value
    expect(screen.getByText('[10,20,0]')).toBeInTheDocument();
    const revertBtn = screen.getByTitle('Revert this change');
    expect(revertBtn).toBeInTheDocument();
    fireEvent.click(revertBtn);
    expect(onRevert).toHaveBeenCalledWith(chg.id);
  });

  it('editing an element calls onEdit with the full new array as atomic value', () => {
    const onEdit = vi.fn();
    const { container } = renderSection(arrayVmad('scalar', [10, 20]), ['A.esm'], {
      editMode: true,
      onEdit,
    });
    toggle('S');
    toggle('Items');

    const inputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(inputs[0], { target: { value: '99' } });
    fireEvent.blur(inputs[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [99, 20]);
  });
});

// ── struct edit mode (13.7) ─────────────────────────────────────────────────────

function structVmad(): VmadCompare {
  return {
    scripts: [script({
      name: 'S',
      properties: [prop({
        name: 'Bounds',
        kind: 'struct',
        types: { 'A.esm': 'Struct' },
        winnerPlugin: 'A.esm',
        raw: { 'A.esm': [
          { name: 'X', type: 'Int', flags: 'Edited', intValue: 1 },
          { name: 'Y', type: 'Int', flags: 'Edited', intValue: 2 },
        ] },
        children: [
          prop({ name: 'X', kind: 'scalar', values: { 'A.esm': 1 }, types: { 'A.esm': 'Int' }, winnerPlugin: 'A.esm' }),
          prop({ name: 'Y', kind: 'scalar', values: { 'A.esm': 2 }, types: { 'A.esm': 'Int' }, winnerPlugin: 'A.esm' }),
        ],
      })],
    })],
  };
}

describe('VmadSection struct edit mode', () => {
  it('expanding a Struct in edit mode shows an input per member', () => {
    const { container } = renderSection(structVmad(), ['A.esm'], { editMode: true, onEdit: vi.fn() });
    toggle('S');
    toggle('Bounds');

    const inputs = container.querySelectorAll('input[type="number"]');
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).value).toBe('1');
    expect((inputs[1] as HTMLInputElement).value).toBe('2');
  });

  it('editing a struct member restages the whole struct subtree at the property path', () => {
    const onEdit = vi.fn();
    const { container } = renderSection(structVmad(), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Bounds');

    const inputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(inputs[0], { target: { value: '99' } });
    fireEvent.blur(inputs[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Bounds`, [
      { name: 'X', type: 'Int', flags: 'Edited', intValue: 99 },
      { name: 'Y', type: 'Int', flags: 'Edited', intValue: 2 },
    ]);
  });
});

function nestedStructVmad(): VmadCompare {
  return {
    scripts: [script({
      name: 'S',
      properties: [prop({
        name: 'Bounds',
        kind: 'struct',
        types: { 'A.esm': 'Struct' },
        winnerPlugin: 'A.esm',
        raw: { 'A.esm': [
          { name: 'X', type: 'Int', intValue: 1 },
          { name: 'Inner', type: 'Struct', members: [{ name: 'Depth', type: 'Int', intValue: 42 }] },
        ] },
        children: [
          prop({ name: 'X', kind: 'scalar', values: { 'A.esm': 1 }, types: { 'A.esm': 'Int' }, winnerPlugin: 'A.esm' }),
          prop({
            name: 'Inner',
            kind: 'struct',
            types: { 'A.esm': 'Struct' },
            winnerPlugin: 'A.esm',
            children: [prop({ name: 'Depth', kind: 'scalar', values: { 'A.esm': 42 }, types: { 'A.esm': 'Int' }, winnerPlugin: 'A.esm' })],
          }),
        ],
      })],
    })],
  };
}

describe('VmadSection nested struct edit mode', () => {
  it('expands struct-in-struct and restages the whole root subtree when a deep member is edited', () => {
    const onEdit = vi.fn();
    renderSection(nestedStructVmad(), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Bounds');
    expect(screen.queryByText('Depth')).not.toBeInTheDocument();

    toggle('Inner');
    expect(screen.getByText('Depth')).toBeInTheDocument();

    // The only editable member visible now is Depth (X is a sibling at the Bounds level).
    const depthInput = screen.getByText('Depth').closest('tr')!.querySelector('input[type="number"]')!;
    fireEvent.change(depthInput, { target: { value: '99' } });
    fireEvent.blur(depthInput);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Bounds`, [
      { name: 'X', type: 'Int', intValue: 1 },
      { name: 'Inner', type: 'Struct', members: [{ name: 'Depth', type: 'Int', intValue: 99 }] },
    ]);
  });
});

function structListVmad(): VmadCompare {
  const inst = (qty: number) => prop({
    name: `[${qty}]`, kind: 'struct', types: { 'A.esm': 'Struct' }, winnerPlugin: 'A.esm',
    children: [prop({ name: 'Qty', kind: 'scalar', values: { 'A.esm': qty }, types: { 'A.esm': 'Int' }, winnerPlugin: 'A.esm' })],
  });
  return {
    scripts: [script({
      name: 'S',
      properties: [prop({
        name: 'Items',
        kind: 'structList',
        types: { 'A.esm': 'ArrayOfStruct' },
        winnerPlugin: 'A.esm',
        raw: { 'A.esm': [
          [{ name: 'Qty', type: 'Int', intValue: 7 }],
          [{ name: 'Qty', type: 'Int', intValue: 9 }],
        ] },
        children: [inst(7), inst(9)],
      })],
    })],
  };
}

describe('VmadSection structList + struct structural edits (13.7)', () => {

  it('Add struct appends a default-valued clone of the first element and restages', () => {
    const onEdit = vi.fn();
    renderSection(structListVmad(), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Items');

    fireEvent.click(screen.getByTitle('Add struct'));

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [
      [{ name: 'Qty', type: 'Int', intValue: 7 }],
      [{ name: 'Qty', type: 'Int', intValue: 9 }],
      [{ name: 'Qty', type: 'Int', intValue: 0 }],
    ]);
  });

  it('Remove struct on an element removes it and restages', () => {
    const onEdit = vi.fn();
    renderSection(structListVmad(), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Items');

    fireEvent.click(screen.getAllByTitle('Remove struct')[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Items`, [
      [{ name: 'Qty', type: 'Int', intValue: 9 }],
    ]);
  });

  it('Remove member on a struct member removes it and restages', () => {
    const onEdit = vi.fn();
    renderSection(structVmad(), ['A.esm'], { editMode: true, onEdit });
    toggle('S');
    toggle('Bounds');

    fireEvent.click(screen.getAllByTitle('Remove member')[0]);

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Bounds`, [
      { name: 'Y', type: 'Int', flags: 'Edited', intValue: 2 },
    ]);
  });

  it('pending struct change shows on the struct property row with a working revert', () => {
    const onRevert = vi.fn();
    const chg = pendingChange('A.esm', String.raw`VMAD\S\Bounds`, [{ name: 'X', type: 'Int', intValue: 99 }]);
    renderSection(structVmad(), ['A.esm'], {
      editMode: true,
      onRevert,
      withPendingCol: 'A.esm',
      pendingChangeMap: { [String.raw`A.esm:VMAD\S\Bounds`]: chg },
    });
    toggle('S');

    const revertBtn = screen.getByTitle('Revert this change');
    fireEvent.click(revertBtn);
    expect(onRevert).toHaveBeenCalledWith(chg.id);
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
    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\MyScript\Enabled`, true);
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

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Count`, 42);
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

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Name`, 'new');
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

    expect(onEdit).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Target`, { formKey: '000123:Foo.esp', alias: 5 });
  });

  it('pending VMAD change shows new value and revert button; clicking revert calls onRevert', () => {
    const onRevert = vi.fn();
    const chg = pendingChange('A.esm', String.raw`VMAD\MyScript\Enabled`, true);
    renderSection(boolVmad(), ['A.esm'], {
      editMode: true,
      onRevert,
      withPendingCol: 'A.esm',
      pendingChangeMap: { [String.raw`A.esm:VMAD\MyScript\Enabled`]: chg },
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

  // ── structural ops (13.8.1) ────────────────────────────────────────────────

  it('add-property control opens a dialog that stages an add_property op', () => {
    const onStructOp = vi.fn();
    const vmad: VmadCompare = { scripts: [script({ name: 'S', flags: { 'A.esm': 'Local' } })] };
    renderSection(vmad, ['A.esm'], { editMode: true, onStructOp });

    fireEvent.click(screen.getByTitle('Add property'));

    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'Alpha' } });
    fireEvent.change(screen.getByLabelText('New property type'), { target: { value: 'Int' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '7' } });
    fireEvent.click(screen.getByText('Add'));

    expect(onStructOp).toHaveBeenCalledWith(
      'A.esm',
      String.raw`VMAD\S\Alpha`,
      { op: 'add_property', type: 'Int', name: 'Alpha', flags: 'Edited', value: 7 },
    );
  });

  it('remove-property control stages a remove_property op', () => {
    const onStructOp = vi.fn();
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({ name: 'IsActive', kind: 'scalar', values: { 'A.esm': true }, types: { 'A.esm': 'Bool' } })],
      })],
    };
    renderSection(vmad, ['A.esm'], { editMode: true, onStructOp, onEdit: vi.fn() });
    toggle('S');

    fireEvent.click(screen.getByTitle('Remove property'));

    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\IsActive`, { op: 'remove_property' });
  });

  it('a pending remove_property renders the property as removed', () => {
    const chg = pendingChange('A.esm', String.raw`VMAD\S\IsActive`, { op: 'remove_property' });
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({ name: 'IsActive', kind: 'scalar', values: { 'A.esm': true }, types: { 'A.esm': 'Bool' } })],
      })],
    };
    renderSection(vmad, ['A.esm'], {
      withPendingCol: 'A.esm',
      pendingChangeMap: { [`A.esm:${chg.fieldPath}`]: chg },
      onRevert: vi.fn(),
    });
    toggle('S');

    expect(screen.getByText('removed')).toBeInTheDocument();
  });

  it('a pending add_property renders as a new added row', () => {
    const chg = pendingChange('A.esm', String.raw`VMAD\S\NewProp`, {
      op: 'add_property', type: 'Int', name: 'NewProp', flags: 'Edited', value: 42,
    });
    const vmad: VmadCompare = { scripts: [script({ name: 'S', flags: { 'A.esm': 'Local' } })] };
    renderSection(vmad, ['A.esm'], {
      withPendingCol: 'A.esm',
      pendingChangeMap: { [`A.esm:${chg.fieldPath}`]: chg },
      onRevert: vi.fn(),
    });
    toggle('S');

    expect(screen.getByText('NewProp')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('editing a pending-added property re-issues add_property with the new value', () => {
    const onStructOp = vi.fn();
    const chg = pendingChange('A.esm', String.raw`VMAD\S\NewProp`, {
      op: 'add_property', type: 'Int', name: 'NewProp', flags: 'Edited', value: 42,
    });
    const vmad: VmadCompare = { scripts: [script({ name: 'S', flags: { 'A.esm': 'Local' } })] };
    renderSection(vmad, ['A.esm'], {
      editMode: true,
      withPendingCol: 'A.esm',
      pendingChangeMap: { [`A.esm:${chg.fieldPath}`]: chg },
      onStructOp,
    });
    toggle('S');

    const input = screen.getByLabelText('Added value for NewProp');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);

    expect(onStructOp).toHaveBeenCalledWith(
      'A.esm',
      String.raw`VMAD\S\NewProp`,
      { op: 'add_property', type: 'Int', name: 'NewProp', flags: 'Edited', value: 99 },
    );
  });

  // ── add/remove script (13.8.2) ─────────────────────────────────────────────

  it('add-script control stages an add_script op even when the record has no VMAD', () => {
    const onStructOp = vi.fn();
    renderSection(null, ['A.esm'], { editMode: true, onStructOp });

    fireEvent.click(screen.getByTitle('Add script'));
    fireEvent.change(screen.getByLabelText('New script name'), { target: { value: 'MyScript' } });
    fireEvent.change(screen.getByLabelText('New script flags'), { target: { value: 'Local' } });
    fireEvent.click(screen.getByText('Add'));

    expect(onStructOp).toHaveBeenCalledWith(
      'A.esm',
      String.raw`VMAD\MyScript`,
      { op: 'add_script', name: 'MyScript', flags: 'Local', properties: [] },
    );
  });

  it('remove-script control stages a remove_script op', () => {
    const onStructOp = vi.fn();
    const vmad: VmadCompare = { scripts: [script({ name: 'S', flags: { 'A.esm': 'Local' } })] };
    renderSection(vmad, ['A.esm'], { editMode: true, onStructOp });

    fireEvent.click(screen.getByTitle('Remove script'));

    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S`, { op: 'remove_script' });
  });

  it('a pending add_script renders as a new added script row', () => {
    const chg = pendingChange('A.esm', String.raw`VMAD\NewScript`, {
      op: 'add_script', name: 'NewScript', flags: 'Local', properties: [],
    });
    renderSection(null, ['A.esm'], {
      withPendingCol: 'A.esm',
      pendingChangeMap: { [`A.esm:${chg.fieldPath}`]: chg },
      onRevert: vi.fn(),
    });

    expect(screen.getByText('NewScript')).toBeInTheDocument();
  });

  // ── change property type (13.8.3) ──────────────────────────────────────────

  it('type dropdown on a property stages a set_type op', () => {
    const onStructOp = vi.fn();
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({ name: 'Counter', kind: 'scalar', values: { 'A.esm': 42 }, types: { 'A.esm': 'Int' } })],
      })],
    };
    renderSection(vmad, ['A.esm'], { editMode: true, onStructOp });
    toggle('S');

    fireEvent.change(screen.getByLabelText('Type for Counter'), { target: { value: 'Float' } });

    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Counter`, { op: 'set_type', type: 'Float' });
  });

  it('a pending set_type renders the new type', () => {
    const chg = pendingChange('A.esm', String.raw`VMAD\S\Counter`, { op: 'set_type', type: 'Float' });
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S',
        properties: [prop({ name: 'Counter', kind: 'scalar', values: { 'A.esm': 42 }, types: { 'A.esm': 'Int' } })],
      })],
    };
    renderSection(vmad, ['A.esm'], {
      withPendingCol: 'A.esm',
      pendingChangeMap: { [`A.esm:${chg.fieldPath}`]: chg },
      onRevert: vi.fn(),
    });
    toggle('S');

    expect(screen.getByText('→ Float')).toBeInTheDocument();
  });

  // ── set flags (13.8.4) ─────────────────────────────────────────────────────

  it('script flags control stages set_flags on the script', () => {
    const onStructOp = vi.fn();
    const vmad: VmadCompare = { scripts: [script({ name: 'S', flags: { 'A.esm': 'Local' } })] };
    renderSection(vmad, ['A.esm'], { editMode: true, onStructOp });

    fireEvent.change(screen.getByLabelText('Flags for S'), { target: { value: 'Inherited' } });

    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S`, { op: 'set_flags', flags: 'Inherited' });
  });

  it('property flags control stages set_flags on the property', () => {
    const onStructOp = vi.fn();
    const vmad: VmadCompare = {
      scripts: [script({
        name: 'S', flags: { 'A.esm': 'Local' },
        properties: [prop({ name: 'Counter', kind: 'scalar', values: { 'A.esm': 42 }, types: { 'A.esm': 'Int' } })],
      })],
    };
    renderSection(vmad, ['A.esm'], { editMode: true, onStructOp });
    toggle('S');

    fireEvent.change(screen.getByLabelText('Flags for Counter'), { target: { value: 'Removed' } });

    expect(onStructOp).toHaveBeenCalledWith('A.esm', String.raw`VMAD\S\Counter`, { op: 'set_flags', flags: 'Removed' });
  });
});
