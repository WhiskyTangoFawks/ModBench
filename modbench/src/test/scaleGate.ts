// The scale gate's harness (ADR-0029, Consequences, bullet 5). Its test mocks `node:fs` and `node:fs/promises` with `countingCalls`,
// and `vscode` with what the Mods and Plugins views register.

import * as vscode from 'vscode';
import { vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instance, type InstanceSubscriber } from '../instanceLoader/instance';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { pluginMetadataFixture, recordTypeCountFixture } from '../client/test/fixtures';
import { changeNamesPlugin, holdsLoadOrder } from '../client/test/says';
import { ModListProvider } from '../mods/ModListProvider';
import { OpenRows } from '../mods/openRows';
import { registerModDecorations } from '../mods/modDecorations';
import { registerConflictTable } from '../mods/conflictTableEditor';
import { modSyncOn } from '../mods/modSync';
import { createPlugins, PLUGINS_KEY_ARGS } from '../plugins';
import { modSyncOver } from '../modCommands/modCommands';
import { fileReadsOver, pluginSyncOver } from '../pluginCommands/plugins';
import { pluginCommandsWith } from './pluginCommandsWith';
import { NO_MOD_STATUSES } from './noModStatuses';
import { adapterOver } from './mo2/adapterOver';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { ModStatuses, STATUS_READS } from '../modStatus/modStatuses';
import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import { fileSystemCalls } from './fileSystemCalls';
import { reachableObjects } from './reachableObjects';
import { FakeCancellationToken } from './vscodeMock';
import { FakeInputBox } from '../drivingLib/test/nameFilterViewHarness';
import { present } from '../ports/present';
import { insertModAtWinningEnd, setEnabledInText } from '../instanceAdapter/mo2/codecs/modlistText';
import { pluginsTextOf } from '../loadOrderFileCodec/pluginsText';
import { handingOneChange } from '../drivingLib/writingGesture';
import { fileAt } from '../instanceLoader/filePresence';
import { FileConflictLookup } from '../instanceLoader/fileConflictIndex';
import { toldAfter, writesToldTo } from '../repositoriesLib/writesTold';
import { heardChanges } from '../symbols/heardChanges';
import { SCRIPTS_READ } from '../symbols/scriptLanguage';
import { registerDeployCommands } from '../toolbox/deployGesture';

/** The work a gesture causes at each layer. */
export interface Cost {
  /** The file system calls from the gesture until its value lands, or until it settles when none lands; its own writes too. */
  readonly read: number;
  /** The objects the value and the Plugins view's facts hold that they did not before. */
  readonly derived: number;
  /** The subscribers called. */
  readonly subscribers: number;
  /** The calls to mEdit, and each entry their answers hold, until the gesture settles. */
  readonly mEdit: number;
  /** The rows the views are asked for, and the decorations each row is asked for. */
  readonly views: number;
  /** The file system calls from the value landing until the gesture settles: what follows it reads. */
  readonly settling: number;
  /** The paths looked up in the file conflict index and the stack, until the gesture settles: a walk of what a change did
   *  not touch shows here. */
  readonly lookups: number;
  /** The URIs made, each a row's or its file's, until the gesture settles: a row derived again that a change did not touch
   *  shows here. */
  readonly rows: number;
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const modName = (n: number): string => `Mod ${String(n).padStart(3, '0')}`;

async function syntheticInstance(mods: number, userlist = '', writtenModFiles = 3): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scale-gate-'));
  const names = Array.from({ length: mods }, (_, n) => modName(n));
  await mkdir(join(root, 'profiles', 'Default'), { recursive: true });
  await mkdir(join(root, 'overwrite'));
  await mkdir(join(root, 'Game', 'Data'), { recursive: true });
  await writeFile(join(root, 'userlist.yaml'), userlist);
  await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n');
  await writeFile(join(root, 'profiles', 'Default', 'modlist.txt'), names.reduceRight((text, name) => setEnabledInText(insertModAtWinningEnd(text, name), name, true), ''));
  await writeFile(join(root, 'profiles', 'Default', 'plugins.txt'), pluginsTextOf(names.map((name) => ({ name: `${name}.esp`, enabled: true }))));
  await Promise.all(names.map(async (name) => {
    await mkdir(join(root, 'mods', name, 'textures', name), { recursive: true });
    await writeFile(join(root, 'mods', name, `${name}.esp`), 'plugin');
    const files = name === modName(0) ? Array.from({ length: writtenModFiles }, (_, at) => `${at}.dds`) : ['a.dds', 'b.dds', 'c.dds'];
    await Promise.all(files.map((file) => writeFile(join(root, 'mods', name, 'textures', name, file), file)));
  }));
  // A modlist's files were written long before a gesture, each stamp old enough to trust.
  const long = new Date(Date.now() - 3_600_000);
  await Promise.all([root, ...(await readdir(root, { recursive: true })).map((path) => join(root, path))].map((path) => utimes(path, long, long)));
  return root;
}

// The work started through the ports the gate hands the Plugins view, which settles once all of it has answered.
function inFlight() {
  const running = new Set<Promise<unknown>>();
  const held = (answer: unknown): void => {
    if (!(answer instanceof Promise)) return;
    running.add(answer);
    void answer.finally(() => running.delete(answer)).catch(() => undefined);
  };
  const tracked = <T extends object>(target: T, onAnswer: (value: unknown) => void = () => undefined): T => new Proxy(target, {
    get(of, key) {
      const member: unknown = Reflect.get(of, key, of);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]): unknown => {
        const answer: unknown = Reflect.apply(member, of, args);
        held(answer);
        if (answer instanceof Promise) void answer.then(onAnswer, () => undefined);
        return answer;
      };
    },
  });
  return {
    tracked,
    async settled(): Promise<void> {
      do {
        await Promise.allSettled([...running]);
        await new Promise((resolve) => setImmediate(resolve));
      } while (running.size > 0);
    },
  };
}

const newObjects = (known: ReadonlySet<object>, ...roots: unknown[]): number =>
  new Set(roots.flatMap((root) => [...reachableObjects(root)]).filter((object) => !known.has(object))).size;

type Tree = Pick<vscode.TreeDataProvider<unknown>, 'getChildren' | 'getTreeItem'> & {
  readonly onDidChangeTreeData: vscode.Event<unknown>;
  /** The user types `text` into the view's name filter. */
  filter(text: string): void;
};

type ViewName = 'Mods' | 'Plugins';

// Each view a gesture asks again: the two trees, and a mod's conflict table open in a tab.
type Shown = Record<ViewName | 'Conflicts', number>;

/** A view as VS Code shows it. Each gesture answers the rows it shows. */
export interface View {
  open(): Promise<number>;
  /** Expands the top-level row whose label ends with `label`. */
  expand(label: string): Promise<number>;
  /** Types `term` into the view's name filter. */
  search(term: string): Promise<number>;
}

const labelOf = ({ label }: vscode.TreeItem): string => (typeof label === 'string' ? label : label?.label ?? '');

// VS Code as it draws each open view with every row collapsed, and asks the decorations of each row it shows.
interface Decorations {
  readonly view: ViewName;
  readonly provider: vscode.FileDecorationProvider;
}

function viewHost(trees: Readonly<Record<ViewName, Tree>>, decorations: readonly Decorations[]) {
  const asked: Record<ViewName, number> = { Mods: 0, Plugins: 0 };
  const pending: Promise<unknown>[] = [];
  const decorated = new Map<string, vscode.Uri>();
  const opened = new Map<Tree, Map<unknown, vscode.TreeItem>>();
  const decorate = ({ view, provider }: Decorations, uris: vscode.Uri | vscode.Uri[] | undefined): void => {
    for (const uri of uris === undefined ? [...decorated.values()] : [uris].flat()) {
      asked[view]++;
      pending.push(Promise.resolve(provider.provideFileDecoration(uri, new FakeCancellationToken())));
    }
  };
  const draw = async (tree: Tree, row: unknown): Promise<vscode.TreeItem> => {
    const item = await tree.getTreeItem(row);
    asked[tree === trees.Mods ? 'Mods' : 'Plugins']++;
    const uri = item.resourceUri;
    if (uri !== undefined && !decorated.has(uri.toString())) {
      decorated.set(uri.toString(), uri);
      for (const decoration of decorations) decorate(decoration, uri);
    }
    return item;
  };
  const drawAll = async (tree: Tree): Promise<number> => {
    const rows = await tree.getChildren() ?? [];
    opened.set(tree, new Map(await Promise.all(rows.map(async (row) => [row, await draw(tree, row)] as const))));
    return rows.length;
  };
  const settled = async (): Promise<void> => { while (pending.length > 0) await Promise.all(pending.splice(0)); };
  const viewOf = (tree: Tree): View => ({
    open: () => drawAll(tree),
    async expand(label) {
      const [row] = present([...opened.get(tree) ?? []].find(([, item]) => labelOf(item).endsWith(label)), `the row ${label}`);
      const children = await tree.getChildren(row) ?? [];
      await Promise.all(children.map((child) => draw(tree, child)));
      return children.length;
    },
    async search(term) {
      tree.filter(term);
      await settled();
      return opened.get(tree)?.size ?? 0;
    },
  });
  const subscriptions = [
    ...Object.values(trees).map((tree) => tree.onDidChangeTreeData((row) => {
      if (opened.has(tree)) pending.push(row === undefined || row === null ? drawAll(tree) : draw(tree, row));
    })),
    ...decorations.flatMap((decoration) => decoration.provider.onDidChangeFileDecorations?.((uris) => { decorate(decoration, uris); }) ?? []),
  ];
  return {
    views: { Mods: viewOf(trees.Mods), Plugins: viewOf(trees.Plugins) },
    settled,
    /** The rows and decorations each view was asked for since the last count. */
    count(): Record<ViewName, number> {
      const counted = { ...asked };
      asked.Mods = 0;
      asked.Plugins = 0;
      return counted;
    },
    dispose(): void { for (const subscription of subscriptions) subscription.dispose(); },
  };
}

interface TablePanel {
  title: string;
  readonly webview: {
    html: string; options: unknown; readonly cspSource: string; asWebviewUri(uri: unknown): unknown;
    postMessage(message: unknown): Promise<boolean>; onDidReceiveMessage(listener: (message: unknown) => void): void;
  };
  onDidDispose(listener: () => void): void;
}

interface ResolvingTable {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument;
  resolveCustomEditor(document: vscode.CustomDocument, panel: TablePanel): void;
}

const isResolvingTable = (value: unknown): value is ResolvingTable =>
  typeof value === 'object' && value !== null && 'openCustomDocument' in value && 'resolveCustomEditor' in value;

// A mod's conflict table, opened as VS Code opens it in a tab, with each message it posts.
function conflictTableOf(registered: readonly (readonly unknown[])[], mod: string): { readonly posted: unknown[] } {
  const [provider] = registered.flatMap(([, held]) => (isResolvingTable(held) ? [held] : []));
  if (provider === undefined) throw new Error('no conflict table was registered');
  const posted: unknown[] = [];
  const panel: TablePanel = {
    title: '',
    webview: {
      html: '', options: undefined, cspSource: 'csp', asWebviewUri: (uri) => uri,
      postMessage: (message) => { posted.push(message); return Promise.resolve(true); }, onDidReceiveMessage: () => undefined,
    },
    onDidDispose: () => undefined,
  };
  provider.resolveCustomEditor(provider.openCustomDocument(vscode.Uri.from({ scheme: 'modbench-conflicts', path: `/${encodeURIComponent(mod)}.modbench-conflicts` })), panel);
  return { posted };
}

/** A gesture in a view, which answers the rows it shows, or a change to the instance, which shows none: made as a
 *  gesture or another program makes it, and the Instance loader told of it as it is. */
export interface Gesture {
  readonly name: string;
  /** The view the gesture opens, closed until it does. */
  readonly opens?: ViewName;
  /** The instance's own sorting rules. */
  readonly userlist?: string;
  /** The files the first mod, the one a gesture writes into, holds; 3 when unsaid, as every other mod holds. */
  readonly writtenModFiles?: number;
  make(at: { root: string; instance: Pick<Instance, 'refresh'>; views: Readonly<Record<ViewName, View>>; client: InMemoryMEditClient }): Promise<number>;
}

export const A_NEW_LOOSE_FILE: Gesture = {
  name: 'a new loose file in one mod',
  async make({ root, instance }) {
    const file = join(root, 'mods', modName(0), 'textures', modName(0), 'changed.dds');
    await writeFile(file, 'changed');
    await instance.refresh([file]);
    return 0;
  },
};

export const A_NEW_LOOSE_FILE_UNDER_A_FILE_RULE: Gesture = {
  ...A_NEW_LOOSE_FILE,
  name: 'a new loose file in one mod, under a rule on every plugin that reads another file',
  userlist: "plugins:\n  - name: 'Mod \\d+\\.esp'\n    msg:\n      - type: warn\n        content: 'It needs its mesh.'\n        condition: 'not file(\"Meshes/x.nif\")'\n",
};

export const A_FILE_A_RULE_READS_REWRITTEN: Gesture = {
  name: 'a file a rule reads rewritten in place, under a rule that checksums every plugin',
  userlist: "plugins:\n  - name: 'Mod \\d+\\.esp'\n    dirty: [{crc: 0xDEADBEEF, util: x}]\n"
    + "  - name: 'Mod 000.esp'\n    msg: [{type: warn, content: 'Its texture changed.', condition: 'checksum(\"textures/Mod 000/a.dds\", 5E75228B)'}]\n",
  async make({ root, instance }) {
    const file = join(root, 'mods', modName(0), 'textures', modName(0), 'a.dds');
    await writeFile(file, 'rewritten');
    await instance.refresh([file]);
    return 0;
  },
};

export const A_GESTURE_WRITING_A_LOOSE_FILE: Gesture = {
  name: 'a gesture that writes one loose file into one mod',
  async make({ root, instance }) {
    const file = join(root, 'mods', modName(0), 'textures', modName(0), 'written.dds');
    await handingOneChange(instance, () => toldAfter([file], () => writeFile(file, 'written')));
    return 0;
  },
};

export const A_RECORD_WRITTEN: Gesture = {
  name: 'a record written into one plugin, which mEdit says changed',
  make({ client }) {
    changeNamesPlugin(client, { name: `${modName(0)}.esp`, origin: modName(0) });
    return Promise.resolve(0);
  },
};

export const NOTHING_WRITTEN: Gesture = {
  name: 'a read of the mod order nothing wrote',
  async make({ root, instance }) {
    await instance.refresh([join(root, 'profiles', 'Default', 'modlist.txt')]);
    return 0;
  },
};

export const REWRITTEN_WITH_ITS_OWN_BYTES: Gesture = {
  name: 'a rewrite of the mod order with its own bytes',
  async make({ root, instance }) {
    const modlist = join(root, 'profiles', 'Default', 'modlist.txt');
    await writeFile(modlist, await readFile(modlist));
    await instance.refresh([modlist]);
    return 0;
  },
};

const gesturesIn = (view: ViewName, row: string): Record<'opening' | 'expanding' | 'searching', Gesture> => ({
  opening: { name: `opening the ${view} view`, opens: view, make: ({ views }) => views[view].open() },
  expanding: { name: `expanding one row of the ${view} view`, make: ({ views }) => views[view].expand(row) },
  searching: { name: `searching the ${view} view by name`, make: ({ views }) => views[view].search(row) },
});

export const IN_MODS = gesturesIn('Mods', modName(0));
export const IN_PLUGINS = gesturesIn('Plugins', `${modName(0)}.esp`);

/** What `gesture` costs at each layer, the rows it shows, and the objects each fact of the value holds that the value before
 *  it did not, on a synthetic instance of `mods` mods. */
export async function costOf(mods: number, gesture: Gesture): Promise<Cost & {
  readonly shown: number; readonly derivedIn: Readonly<Record<string, number>>; readonly viewsIn: Readonly<Shown>;
  /** The times the symbols were told of a change, and deploy's problems read the deployment folder. */
  readonly told: { readonly symbols: number; readonly deployProblems: number };
}> {
  const root = await syntheticInstance(mods, gesture.userlist, gesture.writtenModFiles);
  const adapter = adapterOver(root, { gameFolder: { kind: 'found', root: join(root, 'Game'), dataFolder: join(root, 'Game', 'Data') } });
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getWorkingTreeStatesBeneath', { plugin: [], recordTypes: {}, records: {} });
  client.setQueryAnswer('getDiagnoses', []);
  client.setQueryAnswer('getPluginsIndexing', []);
  let answered = 0;
  const pending = inFlight();
  const counted = pending.tracked(client, (value) => { if (Array.isArray(value)) answered += value.length; });
  const instance = new Instance({ adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: quiet, medit: counted, workspace: fakeWorkspace() });
  const landings: number[] = [];
  const landing: InstanceSubscriber = () => { landings.push(fileSystemCalls.count); };
  const registering = vi.spyOn(vscode.window, 'registerFileDecorationProvider');
  const treeViews = vi.spyOn(vscode.window, 'createTreeView');
  const inputBoxes = vi.spyOn(vscode.window, 'createInputBox');
  const landingSubscription = instance.subscribe(landing);
  const open = new OpenRows(instance);
  const statuses = new ModStatuses(adapter, () => undefined, () => Promise.resolve([]));
  const statusing = instance.subscribe(async (value, _sequence, changed) => {
    statuses.derive(value, changed);
    await statuses.current();
  }, STATUS_READS, (path, value) => statuses.readsFile(path, value));
  const modsTree = new ModListProvider({ instance, statuses, open, reporter: recordingReporter() });
  const settings = { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) };
  const decorations = registerModDecorations(instance, open, settings);
  const modDecorations = registering.mock.calls.length;
  const editors = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
  const conflictTable = registerConflictTable(instance, () => Promise.resolve([]), vscode.Uri.file(root), () => [], recordingReporter(), settings);
  const table = conflictTableOf(editors.mock.calls, modName(1));
  editors.mockRestore();
  const pluginsInstance = pending.tracked(instance);
  const pluginsBox = createPlugins({
    client: counted, facts: pluginsInstance, channel: { ...quiet, show: () => undefined }, reporterFor: () => recordingReporter(),
    registerRepositories: () => Promise.resolve(), ask: scriptedDialog(),
    sourceEditing: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: (job) => job(), refreshSourceControlFor: () => undefined },
  });
  const pluginsView = pluginsBox.onInstance({
    instance: pluginsInstance, commands: pluginCommandsWith(adapter), modStatuses: NO_MOD_STATUSES,
    fileReads: pending.tracked(fileReadsOver(adapter, (path) => fileAt(instance.value, path))),
    syncPlugins: pending.tracked({ run: pluginSyncOver(adapter, counted) }).run,
  });
  const pluginsTree = present(treeViews.mock.calls.find(([id]) => id === PLUGINS_KEY_ARGS.view), 'the Plugins view')[1].treeDataProvider;
  const owned = [landingSubscription, statusing, statuses, open, modsTree, ...decorations, ...conflictTable, pluginsView, pluginsBox];
  const host = viewHost({
    Mods: Object.assign(modsTree, { filter: (text: string) => { modsTree.setFilter(text, true); } }),
    Plugins: {
      getChildren: (row) => pluginsTree.getChildren(row), getTreeItem: (row) => pluginsTree.getTreeItem(row),
      onDidChangeTreeData: present(pluginsTree.onDidChangeTreeData, 'the Plugins view\'s redraws'),
      filter: (text) => {
        pluginsView.nameFilter.open();
        const box: unknown = inputBoxes.mock.results.at(-1)?.value;
        if (!(box instanceof FakeInputBox)) throw new Error('the name filter opened no input box');
        box.type(text);
      },
    },
  }, registering.mock.calls.map(([provider], at) => ({ view: at < modDecorations ? 'Mods' as const : 'Plugins' as const, provider })));
  for (const spy of [registering, treeViews]) spy.mockRestore();
  const modSyncing = modSyncOn({ instance, syncMods: modSyncOver(adapter), channel: quiet });
  let subscribers = 0;
  const outcomes = instance.onListenerOutcome(({ listener, during }) => { if (during === 'value' && listener !== landing) subscribers++; });
  const told = { symbols: 0, deployProblems: 0 };
  const symbols = heardChanges({ asker: { forget: () => undefined, onPluginChanged: () => () => undefined }, instance, facts: SCRIPTS_READ }, () => { told.symbols++; });
  const notAsked = () => Promise.reject(new Error('the gate asks no deploy'));
  const deployment = registerDeployCommands({
    commands: {
      deploy: notAsked, purge: notAsked, moveToOverwrite: notAsked,
      unmanaged: () => { told.deployProblems++; return Promise.resolve({ applied: true, folder: join(root, 'Game', 'Data'), unmanaged: [] }); },
    },
    instance, reporterFor: () => recordingReporter(),
  });
  writesToldTo(instance);
  const settled = async () => {
    await Promise.all([modSyncing.modSync.settled(), pending.settled()]);
    await host.settled();
    await pending.settled();
  };
  try {
    await instance.refresh();
    const { plugins } = instance.value;
    client.setQueryAnswer('getPlugins', plugins.map(({ name, origin }) => pluginMetadataFixture({ name, origin })));
    client.setQueryAnswer('getRecordTypes', ['armo', 'weap'].map((type) => recordTypeCountFixture({ type })));
    holdsLoadOrder(client, { indexed: plugins });
    await settled();
    for (const [name, view] of Object.entries(host.views)) if (name !== gesture.opens) await view.open();
    await settled();
    const known = reachableObjects([instance.value, pluginsView.pluginsShown]);
    host.count();
    table.posted.splice(0);
    subscribers = 0;
    told.symbols = 0;
    told.deployProblems = 0;
    const lookups = vi.spyOn(FileConflictLookup.prototype, 'get');
    const madeFiles = vi.spyOn(vscode.Uri, 'file');
    const madeFrom = vi.spyOn(vscode.Uri, 'from');
    const start = fileSystemCalls.count;
    const asked = client.calls.length + answered;
    const landed = landings.length;

    const shown = await gesture.make({ root, instance, views: host.views, client });
    await settled();

    const looked = lookups.mock.calls.length;
    const made = madeFiles.mock.calls.length + madeFrom.mock.calls.length;
    for (const spy of [lookups, madeFiles, madeFrom]) spy.mockRestore();
    const viewsIn = { ...host.count(), Conflicts: table.posted.length };
    const derivedIn = Object.fromEntries(Object.entries(instance.value).map(([fact, held]) => [fact, newObjects(known, held)]));
    return {
      read: (landings[landed] ?? fileSystemCalls.count) - start, derived: newObjects(known, instance.value, pluginsView.pluginsShown), derivedIn, subscribers, mEdit: client.calls.length + answered - asked,
      views: viewsIn.Mods + viewsIn.Plugins + viewsIn.Conflicts, viewsIn, shown, settling: landings[landed] === undefined ? 0 : fileSystemCalls.count - landings[landed],
      told: { ...told }, lookups: looked, rows: made,
    };
  } finally {
    writesToldTo({ told: () => Promise.resolve({ subscribed: Promise.resolve() }) });
    symbols();
    for (const disposable of [modSyncing, outcomes, host, ...deployment, ...owned, instance]) disposable.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
