import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFilePlain, uriFrom, DataTransferItem, DataTransfer,
} from './vscodeMock';
import { instanceValueFixture } from './mo2/instanceValueFixture';
import { present } from '../ports/present';
import type { InstanceValue } from '../instanceLoader/instance';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../instanceLoader/loadOrderSnapshot';

// A reconcile or a checkbox toggle is a Plugins row change with no keystroke, same as the Mods
// and Downloads filters. Real PluginsTreeProvider; only the InputBox and TreeView are doubles.

const h = vi.hoisted(() => {
  class FakeInputBox {
    value = '';
    placeholder = '';
    buttons: { iconPath: unknown; tooltip: string }[] = [];
    private changeHandlers: ((v: string) => void)[] = [];
    onDidChangeValue(cb: (v: string) => void) { this.changeHandlers.push(cb); return { dispose() { /* no-op */ } }; }
    onDidHide() { return { dispose() { /* no-op */ } }; }
    onDidTriggerButton() { return { dispose() { /* no-op */ } }; }
    show() { /* no-op */ }
    dispose() { /* no-op */ }
    type(text: string) { this.value = text; this.changeHandlers.forEach((cb) => cb(text)); }
  }
  const state = {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    boxes: [] as FakeInputBox[],
  };
  return { FakeInputBox, state };
});

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFilePlain, from: uriFrom }, DataTransferItem, DataTransfer,
  window: {
    createInputBox: () => {
      const box = new h.FakeInputBox();
      h.state.boxes.push(box);
      return box;
    },
  },
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
      h.state.commands.set(id, cb);
      return { dispose: () => h.state.commands.delete(id) };
    },
    executeCommand: () => Promise.resolve(),
  },
}));

import { registerPluginsNameFilter } from '../toolbox';
import { PluginsTreeProvider, type PluginListSource } from '../plugins/PluginsTreeProvider';

// The double the provider's row contract needs: `.value` plus `.subscribe`, structurally
// compatible with `Instance` without ever constructing one.
class FakeInstance {
  value: InstanceValue;
  sequence = 1;
  readFailure: string | undefined = undefined;
  private subscribers: ((value: InstanceValue, sequence: number) => void)[] = [];
  constructor(initial: InstanceValue) { this.value = initial; }
  subscribe(subscriber: (value: InstanceValue, sequence: number) => void) {
    this.subscribers.push(subscriber);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscriber); } };
  }
  publish(value: InstanceValue): void {
    this.value = value;
    this.sequence++;
    for (const subscriber of [...this.subscribers]) subscriber(value, this.sequence);
  }
  onReadFailure() { return { dispose: () => { /* no-op */ } }; }
}

class FakeSource implements PluginListSource {
  setPluginEnabled(): Promise<void> { return Promise.resolve(); }
  reorderPlugins(): Promise<void> { return Promise.resolve(); }
}

function plugin(name: string): LoadOrderPlugin | LoadOrderPluginLine {
  return { name, path: `/fixture/${name}`, origin: 'SomeMod', slot: 0, enabled: true, winning: true };
}

const valueOf = (plugins: (LoadOrderPlugin | LoadOrderPluginLine)[]): InstanceValue =>
  instanceValueFixture({ plugins });

const command = (id: string) => present(h.state.commands.get(id), `the "${id}" command`);
const currentBox = () => present(h.state.boxes.at(-1), 'the most recently created input box');

async function waitForMessage(
  view: { message?: string }, predicate: (m: string | undefined) => boolean, label: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate(view.message)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}; last message: ${String(view.message)}`);
}

describe('the Plugins filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a reconcile, in both directions', async () => {
    h.state.boxes.length = 0;
    h.state.commands.clear();
    const instance = new FakeInstance(valueOf([plugin('TestMod.esp')]));
    const provider = new PluginsTreeProvider({ instance, source: new FakeSource() });
    await provider.getChildren();

    const view: { description?: string; message?: string } = {};
    registerPluginsNameFilter(view, provider);

    await command('modbench.plugin.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(view.message).toBe('No matches for "zzznomatch".');

    // A row change with no keystroke: a reconcile lands a plugin the term matches.
    instance.publish(valueOf([plugin('TestMod.esp'), plugin('zzznomatch.esp')]));
    await waitForMessage(view, (m) => m === undefined, 'the message clearing once a matching plugin lands');
    expect(view.message).toBeUndefined();

    // And back — the same row change reversing, still with nobody typing.
    instance.publish(valueOf([plugin('TestMod.esp')]));
    await waitForMessage(view, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the plugin is gone');
    expect(view.message).toBe('No matches for "zzznomatch".');
  });
});
