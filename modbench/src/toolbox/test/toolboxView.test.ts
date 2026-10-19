import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  created: [] as { id: string; view: { message?: string; dispose: () => void } }[],
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter,
  Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => { for (const part of parts) part.dispose(); } }) },
  window: {
    createTreeView: (id: string) => {
      const view = { message: undefined as string | undefined, dispose: vi.fn() };
      h.created.push({ id, view });
      return view;
    },
  },
}));

import { present } from '../../ports/present';
import { createToolboxView } from '../toolboxView';

describe('the Toolbox view', () => {
  it('is modbench.toolbox, and shows a gesture\'s phase on its message line until the gesture gives it back', () => {
    const toolbox = createToolboxView({ instance: undefined });
    const { id, view } = present(h.created[0], 'the created tree view');

    toolbox.say('Update manifest — reading…');
    const during = view.message;
    toolbox.say(undefined);

    expect([id, during, view.message]).toEqual(['modbench.toolbox', 'Update manifest — reading…', undefined]);
  });

  it('disposes the tree view with it', () => {
    const toolbox = createToolboxView({ instance: undefined });

    toolbox.dispose();

    expect(h.created.at(-1)?.view.dispose).toHaveBeenCalledOnce();
  });
});
