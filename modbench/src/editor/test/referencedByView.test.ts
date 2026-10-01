import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  views: [] as { title?: string; description?: string; message?: string; dispose(): void }[],
  treeOptions: [] as unknown[],
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon,
  Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => parts.forEach((p) => p.dispose()) }) },
  window: {
    createTreeView: (_id: string, options: unknown) => {
      h.treeOptions.push(options);
      const view = { dispose: () => undefined };
      h.views.push(view);
      return view;
    },
  },
  commands: {
    registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
      h.commands.set(id, run);
      return { dispose: () => h.commands.delete(id) };
    },
    executeCommand: (id: string, ...args: unknown[]) => Promise.resolve(h.commands.get(id)?.(...args)),
  },
}));

import { createReferencedByView, referencedByTitle, type ReferencedByFilter, type ReferencedByFilterDeps } from '../referencedByView';
import { InMemoryMEditClient } from '../../client';
import type { ReferenceResult } from '../../client';

const reference = (formKey: string): ReferenceResult => ({
  formKey, plugin: 'Fallout4.esm', fieldPath: 'Keywords[0]', recordType: 'weap', recordTypeName: 'Weapon',
  editorId: null, origin: 'Fallout4.esm',
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeView(client = new InMemoryMEditClient()) {
  const filter = { setBaseDescription: vi.fn(), refresh: vi.fn(), open: vi.fn(), clear: vi.fn(), dispose: vi.fn() } satisfies ReferencedByFilter;
  let deps: ReferencedByFilterDeps | undefined;
  const made = createReferencedByView(client, vi.fn(), (given) => { deps = given; return filter; });
  return { ...made, filter, deps: () => deps };
}

describe('referencedByTitle', () => {
  it('counts the records that reference it, and shows no count while it is not known', () => {
    expect(referencedByTitle(12)).toBe('Referenced By (12)');
    expect(referencedByTitle(0)).toBe('Referenced By (0)');
    expect(referencedByTitle(undefined)).toBe('Referenced By');
  });
});

describe('the Referenced By view', () => {
  it('collapses all from its title bar and selects several rows', () => {
    makeView();
    expect(h.treeOptions.at(-1)).toMatchObject({ canSelectMany: true, showCollapseAll: true });
  });

  it('hands the shared filter its own context key, its provider\'s message and the term after the record', () => {
    const { deps } = makeView();
    expect(deps()).toMatchObject({ object: 'modbench.referrer', termPlacement: 'afterBase' });
    expect(deps()?.viewMessage()).toBe('Open a record to see what references it.');
  });

  it('has no count in its title until the list follows a record', () => {
    makeView();
    expect(h.views.at(-1)?.title).toBe('Referenced By');
  });

  it('titles itself with the count and names the record, once the read lands', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', [reference('000002:Fallout4.esm'), reference('000003:Fallout4.esm')]);
    client.setQueryAnswer('getComparison', null);
    const { provider, filter } = makeView(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    await settle();
    expect(h.views.at(-1)?.title).toBe('Referenced By (2)');
    expect(filter.setBaseDescription).toHaveBeenLastCalledWith('000001:Fallout4.esm');
  });

  it('reverses the rows from the sort toggle and back', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', [reference('000002:Fallout4.esm'), reference('000003:Fallout4.esm')]);
    client.setQueryAnswer('getComparison', null);
    const { provider } = makeView(client);
    provider.showFor('000001:Fallout4.esm');
    await h.commands.get('modbench.referrer.sortDescending')?.();
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['000003:Fallout4.esm', '000002:Fallout4.esm']);
    await h.commands.get('modbench.referrer.sortAscending')?.();
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['000002:Fallout4.esm', '000003:Fallout4.esm']);
  });
});
