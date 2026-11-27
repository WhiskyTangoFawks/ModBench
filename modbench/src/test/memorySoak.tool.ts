// A soak, so a tool (spec/architecture/tests.md), run as docs/agents/release.md says.
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const host = await import('../plugins/test/vscodeHost');
  const watched = (await import('./mo2/fakeVscodeWatcher')).fakeVscodeModule();
  return { ...host, RelativePattern: watched.RelativePattern, workspace: { ...host.workspace, createFileSystemWatcher: watched.workspace.createFileSystemWatcher } };
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString, writeHeapSnapshot } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { host } from '../plugins/test/vscodeHost';
import { pluginsIndexedOver } from '../plugins/test/pluginsOver';
import { instanceOnDisk } from '../instanceAdapter/test/instanceOnDisk';
import { recordTypeCountFixture } from '../client/test/fixtures';
import type { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { MoveToTrash } from '../ports/trash';
import { adapterOver } from './mo2/adapterOver';
import { watchers } from './mo2/fakeVscodeWatcher';
import { present } from '../ports/present';

const isCollector = (value: unknown): value is () => void => typeof value === 'function';
setFlagsFromString('--expose-gc');
const exposed: unknown = runInNewContext('gc');
if (!isCollector(exposed)) throw new Error('V8 exposed no garbage collector');
const collectGarbage = exposed;

const ROUNDS = 400;
const WARM_UP = 100;
const PACKAGE_FILES = 100;
const TRASH: MoveToTrash = (file) => rm(file, { recursive: true, force: true });
const PLUGIN = { name: 'MyPatch.esp', origin: 'ModA' };
const NEW = '000900:MyPatch.esp';

const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }); };
// A file as it stands once the session has moved on from writing it: its stamp old enough to keep what was read of it.
const aged = (path: string): Promise<void> => { const past = new Date(Date.now() - 3_600_000); return utimes(path, past, past); };
const settle = (): Promise<unknown> => new Promise((resolve) => { setImmediate(resolve); });

interface HeapSnapshot {
  readonly snapshot: { readonly meta: { readonly node_fields: readonly string[]; readonly node_types: readonly [readonly string[]] } };
  readonly nodes: readonly number[];
}

// The values the heap holds. Compiled code and V8's own bookkeeping grow as code warms, and hold nothing of Modbench's.
const VALUES = new Set(['object', 'array', 'string', 'concatenated string', 'sliced string', 'closure', 'regexp', 'number', 'bigint', 'symbol']);

// A snapshot of the heap, written to `file` once what no one holds is collected.
async function snapshotTo(file: string): Promise<string> {
  for (let pass = 0; pass < 3; pass++) {
    await settle();
    collectGarbage();
  }
  return writeHeapSnapshot(file);
}

const isHeapSnapshot = (value: unknown): value is HeapSnapshot => typeof value === 'object' && value !== null && 'snapshot' in value && 'nodes' in value;

// The values a snapshot holds, read after the soak so reading one adds nothing to the other. A count, not bytes: a leak
// adds values each round, while one string of git's answer can be any length.
async function heldValues(file: string): Promise<number> {
  const read: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isHeapSnapshot(read)) throw new Error(`${file} is no heap snapshot`);
  const { snapshot: { meta: { node_fields: fields, node_types: [types] } }, nodes } = read;
  const type = fields.indexOf('type');
  let held = 0;
  for (let at = 0; at < nodes.length; at += fields.length) if (VALUES.has(types[nodes[at + type] ?? -1] ?? '')) held++;
  return held;
}

// The instance, a repository with its path tokens written, and a release to install.
async function instance(): Promise<{ root: string; adapter: InstanceAdapter; release: string }> {
  const root = await instanceOnDisk();
  git(root, 'init', '-q', '-b', 'main');
  const adapter = adapterOver(root);
  await adapter.writePathTokens();
  git(root, 'add', '--', 'ModOrganizer.ini');
  git(root, 'commit', '-q', '-m', 'Base');
  const release = await mkdtemp(join(tmpdir(), 'modbench-soak-release-'));
  await Promise.all(Array.from({ length: PACKAGE_FILES }, (_, n) => writeFile(join(release, `${n}.dds`), `${n}`)));
  return { root, adapter, release };
}

// Install, read, commit, read, uninstall and commit, read: the Mods view's everyday loop over the Instance adapter. The
// fake VS Code forgets the watchers it made; Modbench holds them while it needs them.
async function modsRound({ root, adapter, release }: Awaited<ReturnType<typeof instance>>, round: number): Promise<void> {
  const name = `Soak ${round}`;
  const folder = join(root, 'mods', name);
  const committed = async (message: string): Promise<void> => { await adapter.commitFolder(folder, message); await aged(join(root, '.git', 'index')); };
  await adapter.install({ kind: 'folder', path: release }, { kind: 'new', name }, TRASH);
  await Promise.all([folder, ...(await readdir(folder)).map((file) => join(folder, file))].map(aged));
  await adapter.changeModOrder('Default', () => [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name } }]);
  await adapter.reading();
  await committed(name);
  await adapter.reading();
  await adapter.changeModOrder('Default', () => [{ kind: 'dropMod', mod: name }]);
  await adapter.trashEntryFolder({ kind: 'mod', name }, TRASH);
  await committed(`Uninstall ${name}`);
  await adapter.reading();
  watchers.length = 0;
}

// The listeners on mEdit's change event the Plugins view holds.
function listening(client: InMemoryMEditClient): () => number {
  let live = 0;
  const subscribe = client.onDidChange.bind(client);
  client.onDidChange = (listener) => {
    live++;
    const subscription = subscribe(listener);
    return { dispose: () => { live--; subscription.dispose(); } };
  };
  return () => live;
}

// Creates a record that lands, and one whose create throws: the Plugins view's everyday loop over mEdit.
async function pluginsView() {
  const made = await pluginsIndexedOver([PLUGIN], {
    sourceEditing: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: (job) => job(), refreshSourceControlFor: () => undefined },
  });
  const { client } = made;
  client.setQueryAnswer('getCreatableRecordTypes', [{ type: 'npc_', displayName: 'Non-Player Character' }]);
  client.setQueryAnswer('getRecordTypes', [recordTypeCountFixture({ type: 'npc_', count: 1, displayName: 'Non-Player Character' })]);
  client.setQueryAnswer('getRecords', { items: [], total: 0 });
  const [npcs] = await made.rows(made.row('MyPatch.esp', 'ModA'));
  const group = present(npcs, 'the NPC group');
  const listeners = listening(client);
  const create = () => host.run('modbench.record.create', group);
  // What the doubles record of each round, which Modbench never holds.
  const forgetRecorded = (): void => {
    host.forgetRecorded();
    for (const recorded of [client.calls, made.output, made.view().reveals, ...[...made.reporters.values()].flatMap(({ reports, landings, shownFailures, selectionOutcomeCalls }) => [reports, landings, shownFailures, selectionOutcomeCalls])]) recorded.length = 0;
  };
  return {
    listeners,
    async round(): Promise<void> {
      client.setCommandHandler('getCreateChanges', () => Promise.resolve({ formKey: NEW, moves: [], deletions: [], documents: [] }));
      await create();
      client.change([{ plugin: PLUGIN, keys: [NEW] }]);
      client.setCommandHandler('getCreateChanges', () => Promise.reject(new Error('connection reset')));
      await create().catch(() => undefined);
      await settle();
      forgetRecorded();
    },
  };
}

describe('Modbench over a session', () => {
  it('holds as much memory, and as many listeners on mEdit, after every round of the everyday loop as after the first', async () => {
    const mods = await instance();
    const plugins = await pluginsView();
    const snapshots = await mkdtemp(join(tmpdir(), 'modbench-soak-heap-'));
    const round = async (n: number): Promise<void> => { await modsRound(mods, n); await plugins.round(); };
    try {
      for (let n = 0; n < WARM_UP; n++) await round(n);
      const [warm, listenersWarm] = [await snapshotTo(join(snapshots, 'warm.heapsnapshot')), plugins.listeners()];
      for (let n = WARM_UP; n < ROUNDS; n++) await round(n);
      const [after, listenersAfter] = [await snapshotTo(join(snapshots, 'after.heapsnapshot')), plugins.listeners()];
      const valuesGained = await heldValues(after) - await heldValues(warm);
      console.log('SOAK', { valuesGained, rounds: ROUNDS - WARM_UP, listenersGained: listenersAfter - listenersWarm });

      expect(listenersAfter - listenersWarm, 'the listeners on mEdit gained').toBe(0);
      expect(valuesGained, 'the values held for good, fewer than one a round').toBeLessThan(ROUNDS - WARM_UP);
    } finally {
      await rm(mods.root, { recursive: true, force: true });
      await rm(mods.release, { recursive: true, force: true });
      await rm(snapshots, { recursive: true, force: true });
    }
  }, 1_800_000);
});
