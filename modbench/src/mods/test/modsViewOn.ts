import { vi } from 'vitest';
import type * as vscode from 'vscode';
import type { InstanceValue } from '../../instanceLoader/instance';
import { createModsView } from '../modsView';
import { MODS_KEY_ARGS } from '../gestureEntry';
import { ArchivedCopies } from '../archivedCopies';
import { isUri, modArgumentOf, separatorArgumentOf } from '../../drivingLib/argument';
import { createFocusedView } from '../../drivingLib/focusedView';
import { createModSync } from '../../drivingLib/syncFailureReport';
import { ModStatuses } from '../../modStatus/modStatuses';
import { modCommands } from '../../modCommands/modCommands';
import { entryRenameCommands } from '../../modCommands/renameEntry';
import { sourceCommands, type SourceCommands } from '../../sourceCommands/sourceCommands';
import { oneAtATime } from '../../textDocuments/oneAtATime';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, type FakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { scriptedDialog, tagRecordingReporterFor } from '../../test/surfacingDoubles';
import { recordingTasks } from '../../test/recordingTasks';
import { ORDER_SENT } from '../../test/orderSent';
import { progressSteps } from '../../test/recordedProgress';
import { present } from '../../ports/present';
import { FakeCancellationToken, DataTransfer, TreeItem, Uri } from '../../test/vscodeMock';
import { forgetSeen, seen } from './modsVscode';

type ModsViewDeps = Parameters<typeof createModsView>[0];
type Row = vscode.TreeItem;

interface Options<I> extends Partial<Omit<ModsViewDeps, 'instance'>> {
  /** The value the FakeInstance starts at, when no `instance` is handed. */
  value?: InstanceValue;
  instance?: I;
  /** The Instance adapter every default command writes through. */
  adapter?: FakeInstanceAdapter;
  /** Replaces these of the source commands the default source gestures run. */
  sourceCommands?: Partial<SourceCommands>;
}

/** Settles once every promise chained so far has: what a check that something did not happen waits for, and a step
 *  that must land before the next one changes what the fakes answer. */
export const everyChainedPromiseSettled = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** The label VS Code shows on the row. */
export const labelOf = ({ label }: Row): string | undefined => (typeof label === 'object' ? label.label : label);

/** Each install the adapter was asked for: the package, where it lands, and the FOMOD's answer. */
export const installs = ({ adapter }: { adapter: FakeInstanceAdapter }) =>
  adapter.calls.flatMap((call) => (call.verb === 'install' ? [{ package: call.package, target: call.target, fomod: call.fomod }] : []));

/** The path of each folder revealed in the Explorer. */
export const revealed = (): (string | undefined)[] =>
  seen.executed.filter(([command]) => command === 'revealInExplorer').map(([, uri]) => (isUri(uri) ? uri.fsPath : undefined));

const namedBy = (row: Row): string | undefined => modArgumentOf(row)?.name ?? separatorArgumentOf(row)?.name ?? labelOf(row);

/** The Mods view as `extension.ts` builds it, each dep a quiet fake a test may replace, driven as VS Code drives it.
 *  One view per test: building it empties what VS Code saw. */
export function modsViewOn<I extends ModsViewDeps['instance'] = FakeInstance>({ value, instance, adapter = fakeInstanceAdapter(), sourceCommands: replaced, ...deps }: Options<I> = {}) {
  forgetSeen();
  progressSteps.length = 0;
  const client = new InMemoryMEditClient();
  const { reporter, tags, reporterFor } = tagRecordingReporterFor();
  const lines: string[] = [];
  const ask = scriptedDialog();
  const trash = vi.fn<(path: string) => Promise<void>>().mockResolvedValue();
  const focusedView = createFocusedView();
  const held = instance ?? new FakeInstance(value ?? instanceValueFixture());
  const mods = createModsView({
    instance: held,
    commands: modCommands(adapter.adapter),
    renames: entryRenameCommands({ adapter: adapter.adapter, client }),
    source: { applyWorkspaceChanges: () => Promise.resolve(), oneAtATime: oneAtATime(), refreshSourceControlFor: () => undefined },
    copyReads: adapter.adapter,
    channel: { warn: (line) => { lines.push(line); } },
    reporterFor, ask, trash,
    extensionUri: Uri.file('/extension'),
    downloadsView: 'modbench.downloads',
    focusedView,
    modSync: createModSync(() => Promise.resolve({ applied: true as const, added: [], dropped: [] }), { error: () => undefined, info: () => undefined }, 'modlist.txt'),
    sourceGestures: {
      commands: {
        ...sourceCommands({ client, adapter: adapter.adapter, saveUnsaved: () => Promise.resolve([]), loadOrderSnapshot: ORDER_SENT, tasks: recordingTasks(), trash }),
        ...replaced,
      },
      pluginsView: 'modbench.pluginListTree', say: () => undefined, registerRepositories: () => Promise.resolve(),
    },
    manifestGestures: {
      toolboxView: 'modbench.toolbox', say: () => undefined,
      commands: { updateManifest: vi.fn(), restoreFromManifest: vi.fn(), ignoreFiles: vi.fn() },
    },
    checkForUpdates: vi.fn(),
    statuses: new ModStatuses(adapter.adapter, () => undefined, () => Promise.resolve([])),
    archivedCopies: new ArchivedCopies(client, () => Promise.resolve({ kind: 'unreadable', reason: 'no stamp' })),
    ...deps,
  });
  focusedView.follow(MODS_KEY_ARGS.view, mods.view);
  const view = present(seen.views.get(MODS_KEY_ARGS.view), 'the Mods tree view');
  const provider = view.treeDataProvider;
  /** The rows VS Code shows under `parent`, or at the root, each drawn as VS Code draws it. */
  const rows = async (parent?: Row): Promise<Row[]> => {
    const shown = ((await provider.getChildren(parent)) ?? []).filter((row) => row instanceof TreeItem);
    await Promise.all(shown.map(async (row) => await provider.getTreeItem(row)));
    return shown;
  };
  return {
    mods, view, instance: held, adapter, client, reporter, tags, ask, trash, focusedView,
    /** Each line the view wrote to the Output. */
    lines,
    rows,
    labels: async (parent?: Row) => (await rows(parent)).map(labelOf),
    /** The row under `parent`, or at the root, of the mod or separator `name`, else labelled `name`. */
    row: async (name: string, parent?: Row): Promise<Row> =>
      present((await rows(parent)).find((row) => namedBy(row) === name), `the "${name}" row`),
    parentOf: (row: Row) => provider.getParent?.(row),
    /** Runs a command the view registered, with the arguments VS Code passes. */
    run: (command: string, ...args: unknown[]) => Promise.resolve(present(seen.commands.get(command), `the "${command}" command`)(...args)),
    /** Drags `dragged` onto `target`, or onto the space below the rows. */
    drop: async (dragged: readonly Row[], target: Row | undefined) => {
      const controller = present(view.options.dragAndDropController, 'the Mods drag and drop controller');
      const transfer = new DataTransfer();
      await controller.handleDrag?.(dragged, transfer, new FakeCancellationToken());
      await controller.handleDrop?.(target, transfer, new FakeCancellationToken());
    },
    /** The decorations the registered providers answer for `uri`. */
    decorationsOf: async (uri: vscode.Uri) =>
      (await Promise.all(seen.decorationProviders.map(async (each) => await each.provideFileDecoration(uri, new FakeCancellationToken())))).filter((one) => one != null),
    diagnostics: (collection: string) => present(seen.diagnostics.get(collection), `the "${collection}" diagnostic collection`),
  };
}
