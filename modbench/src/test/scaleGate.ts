// The scale gate's harness (ADR-0029, Consequences, bullet 5). Its test mocks `node:fs` and `node:fs/promises` with `countingCalls`,
// and `vscode.window` with a `registerFileDecorationProvider`.

import * as vscode from 'vscode';
import { vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instance, type InstanceSubscriber, type InstanceValue } from '../instanceLoader/instance';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { ModListProvider } from '../mods/ModListProvider';
import { OpenRows } from '../mods/openRows';
import { registerModDecorations } from '../mods/modDecorations';
import { modSyncOn } from '../mods/modSync';
import { pluginSyncOn } from '../plugins/pluginSync';
import { modSyncOver } from '../modCommands/modCommands';
import { pluginSyncOver } from '../pluginCommands/plugins';
import { pluginsTreeOver } from '../plugins/test/pluginsTreeOver';
import { adapterOver } from './mo2/adapterOver';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { NO_MOD_STATUSES } from './noModStatuses';
import { recordingReporter } from './surfacingDoubles';
import { fileSystemCalls } from './fileSystemCalls';
import { insertModAtWinningEnd, setEnabledInText } from '../instanceAdapter/mo2/codecs/modlistText';
import { pluginsTextOf } from '../loadOrderFileCodec/pluginsText';

/** The work a change causes at each layer. */
export interface Cost {
  /** The file system calls from the change until its value lands, or until it settles when none lands; its own writes too. */
  readonly read: number;
  /** The objects the value holds that the value before it did not. */
  readonly derived: number;
  /** The subscribers called. */
  readonly subscribers: number;
  /** The rows the views are asked for again, and the decorations each row is asked for again. */
  readonly views: number;
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const modName = (n: number): string => `Mod ${String(n).padStart(3, '0')}`;

async function syntheticInstance(mods: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scale-gate-'));
  const names = Array.from({ length: mods }, (_, n) => modName(n));
  await mkdir(join(root, 'profiles', 'Default'), { recursive: true });
  await mkdir(join(root, 'overwrite'));
  await mkdir(join(root, 'Game', 'Data'), { recursive: true });
  await writeFile(join(root, 'Game', 'Data', 'Fallout4.esm'), 'master');
  await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n');
  await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), names.reduceRight((text, name) => setEnabledInText(insertModAtWinningEnd(text, name), name, true), ''));
  await writeFile(join(root, 'profiles', 'Default', 'plugins.txt'), pluginsTextOf(names.map((name) => ({ name: `${name}.esp`, enabled: true }))));
  await Promise.all(names.map(async (name) => {
    await mkdir(join(root, 'mods', name, 'textures', name), { recursive: true });
    await writeFile(join(root, 'mods', name, `${name}.esp`), 'plugin');
    await Promise.all(['a.dds', 'b.dds', 'c.dds'].map((file) => writeFile(join(root, 'mods', name, 'textures', name, file), file)));
  }));
  return root;
}

function reachableObjects(value: unknown): Set<object> {
  const seen = new Set<object>();
  const stack = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if ((typeof next !== 'object' && typeof next !== 'function') || next === null || seen.has(next)) continue;
    seen.add(next);
    if (typeof next === 'function') continue;
    const children = next instanceof Map ? [...next].flat() : next instanceof Set ? [...next] : Object.values(next);
    for (const child of children) stack.push(child);
  }
  return seen;
}

const newObjects = (before: InstanceValue, after: InstanceValue): number => {
  const known = reachableObjects(before);
  return [...reachableObjects(after)].filter((object) => !known.has(object)).length;
};

type Tree = Pick<vscode.TreeDataProvider<unknown>, 'getChildren' | 'getTreeItem'> & { readonly onDidChangeTreeData: vscode.Event<unknown> };

const NEVER_CANCELLED: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

// VS Code as it draws each tree with every row collapsed, and the decorations of each row it shows.
function viewHost(trees: readonly Tree[], decorations: readonly vscode.FileDecorationProvider[]) {
  let asked = 0;
  const pending: Promise<unknown>[] = [];
  const shown = new Map<string, vscode.Uri>();
  const draw = async (tree: Tree, row: unknown): Promise<void> => {
    const item = await tree.getTreeItem(row);
    asked++;
    if (item.resourceUri !== undefined) shown.set(item.resourceUri.toString(), item.resourceUri);
  };
  const drawAll = async (tree: Tree): Promise<void> => { await Promise.all((await tree.getChildren() ?? []).map((row) => draw(tree, row))); };
  const decorate = (provider: vscode.FileDecorationProvider, uris: vscode.Uri | vscode.Uri[] | undefined): void => {
    for (const uri of uris === undefined ? [...shown.values()] : [uris].flat()) {
      asked++;
      pending.push(Promise.resolve(provider.provideFileDecoration(uri, NEVER_CANCELLED)));
    }
  };
  const subscriptions = [
    ...trees.map((tree) => tree.onDidChangeTreeData((row) => { pending.push(row === undefined || row === null ? drawAll(tree) : draw(tree, row)); })),
    ...decorations.flatMap((provider) => provider.onDidChangeFileDecorations?.((uris) => { decorate(provider, uris); }) ?? []),
  ];
  return {
    async settled(): Promise<void> { while (pending.length > 0) await Promise.all(pending.splice(0)); },
    /** The rows and decorations asked for since the last count. */
    count(): number {
      const counted = asked;
      asked = 0;
      return counted;
    },
    dispose(): void { for (const subscription of subscriptions) subscription.dispose(); },
  };
}

/** A change to the instance, made as a gesture or another program makes it, and the Instance loader told of it as it is. */
export interface Change {
  readonly name: string;
  make(root: string, instance: Pick<Instance, 'refresh'>): Promise<void>;
}

export const A_NEW_LOOSE_FILE: Change = {
  name: 'a new loose file in one mod',
  async make(root, instance) {
    const file = join(root, 'mods', modName(0), 'textures', modName(0), 'changed.dds');
    await writeFile(file, 'changed');
    await instance.refresh([file]);
  },
};

/** What `change` costs at each layer, on a synthetic instance of `mods` mods. */
export async function costOf(mods: number, change: Change): Promise<Cost> {
  const root = await syntheticInstance(mods);
  const adapter = adapterOver(root, { gameFolder: { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } });
  const client = new InMemoryMEditClient();
  const instance = new Instance({ adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: quiet, medit: client, workspace: fakeWorkspace() });
  const landings: number[] = [];
  const landing: InstanceSubscriber = () => { landings.push(fileSystemCalls.count); };
  const registering = vi.spyOn(vscode.window, 'registerFileDecorationProvider');
  const landingSubscription = instance.subscribe(landing);
  const open = new OpenRows(instance);
  const modsTree = new ModListProvider({ instance, statuses: NO_MOD_STATUSES, open, reporter: recordingReporter() });
  const decorations = registerModDecorations(instance, open, { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) });
  const pluginsTree = pluginsTreeOver(instance, { client });
  const owned = [landingSubscription, open, modsTree, ...decorations, pluginsTree];
  const views = viewHost([modsTree, pluginsTree], registering.mock.calls.map(([provider]) => provider));
  registering.mockRestore();
  const modSyncing = modSyncOn({ instance, syncMods: modSyncOver(adapter), channel: quiet });
  const pluginSyncing = pluginSyncOn({ instance, syncPlugins: pluginSyncOver(adapter, client), channel: quiet });
  let subscribers = 0;
  const outcomes = instance.onListenerOutcome(({ listener, during }) => { if (during === 'value' && listener !== landing) subscribers++; });
  const settled = () => Promise.all([modSyncing.modSync.settled(), pluginSyncing.pluginSync.settled(), views.settled()]);
  try {
    await instance.refresh();
    await settled();
    const before = instance.value;
    views.count();
    subscribers = 0;
    const start = fileSystemCalls.count;
    const landed = landings.length;

    await change.make(root, instance);
    await settled();

    return { read: (landings[landed] ?? fileSystemCalls.count) - start, derived: newObjects(before, instance.value), subscribers, views: views.count() };
  } finally {
    for (const disposable of [modSyncing, pluginSyncing, outcomes, views, ...owned, instance]) disposable.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
