import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter } from '../../test/vscodeMock';

const h = vi.hoisted(() => ({
  created: [] as { id: string; options: { canSelectMany?: boolean; showCollapseAll?: boolean }; view: { message?: string; dispose: () => void } }[],
}));

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter,
  Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => { for (const part of parts) part.dispose(); } }) },
  window: {
    createTreeView: (id: string, options: { canSelectMany?: boolean; showCollapseAll?: boolean }) => {
      const view = { message: undefined as string | undefined, dispose: vi.fn() };
      h.created.push({ id, options, view });
      return view;
    },
  },
}));

import { present } from '../../ports/present';
import { NO_DEPLOYMENT_FOLDER } from '../../test/noDeploymentFolder';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
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

  it('leaves a gesture\'s phase out of the agent\'s lines', () => {
    const toolbox = createToolboxView({ instance: undefined });
    const { view } = present(h.created.at(-1), 'the created tree view');
    const shown = () => [view.message, toolbox.messages()];

    toolbox.say('Update manifest — reading…');
    const during = shown();
    toolbox.say(undefined);

    expect([during, shown()]).toEqual([
      ['Update manifest — reading…', []],
      [undefined, []],
    ]);
  });

  it('gives the agent the instance\'s line when no gesture speaks', () => {
    const instance = new FakeInstance(instanceValueFixture());
    const toolbox = createToolboxView({ instance, channel: { warn: () => undefined }, deploymentFolder: NO_DEPLOYMENT_FOLDER, pluginsTxtPlace: () => Promise.resolve({ why: 'none' }) });
    const { view } = present(h.created.at(-1), 'the created tree view');

    instance.fail('the modlist is unreadable');

    expect([view.message, toolbox.messages()]).toEqual(['Showing the last good read: the modlist is unreadable', ['Showing the last good read: the modlist is unreadable']]);
  });

  it('is a readout: its rows select one at a time and it has no Collapse All (toolbox.md)', () => {
    createToolboxView({ instance: undefined });

    const { canSelectMany, showCollapseAll } = present(h.created.at(-1), 'the created tree view').options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: undefined, showCollapseAll: undefined });
  });

  it('disposes the tree view with it', () => {
    const toolbox = createToolboxView({ instance: undefined });

    toolbox.dispose();

    expect(h.created.at(-1)?.view.dispose).toHaveBeenCalledOnce();
  });
});
