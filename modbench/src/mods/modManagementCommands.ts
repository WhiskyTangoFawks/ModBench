import * as vscode from 'vscode';
import * as path from 'node:path';
import { ModListProvider, ModNode, OverwriteNode, OVERWRITE_NODE_KIND, SeparatorNode, type ModlistNode, type SortDirection } from './ModListProvider';
import { modsGestureEntry, pluralArgument, registerModsGesture, selectionArgument, singularArgument, type GestureEntry } from './gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveMods,
  moveSeparators,
  renameSeparator,
  setModsEnabled,
  uninstallMod,
  type ModlistSelectionResult,
  type MovePlace,
} from '../modlist/modlist';
import { endAtTop, isSeparatorsPlace, modsMovePick, moveTargetOf, separatorsMovePick, type MovePickItem } from './movePick';
import { ARCHIVE_EXTENSIONS, defaultModName, installFromArchive, installFromFolder } from '../install/install';
import { collidingModName } from './modNameCollision';
import { errorMessage } from '../ports/errorMessage';
import { applyOrThrow } from '../ports/applyOrThrow';

/** The Mods tree's view direction writes no MO2 file, so it lives with the view it flips. It
 *  starts losing at the top on each activation, and the context key, which outlives an extension
 *  host restart, is told so. */
export function registerModListCoreCommands(modListProvider: Pick<ModListProvider, 'setViewDirection'>): vscode.Disposable[] {
  const show = (direction: SortDirection) => {
    modListProvider.setViewDirection(direction);
    void vscode.commands.executeCommand('setContext', 'modbench.mod.winningAtTop', direction === 'winningAtTop');
  };
  void vscode.commands.executeCommand('setContext', 'modbench.mod.winningAtTop', false);
  return [
    vscode.commands.registerCommand('modbench.mod.sortWinningAtTop', () => show('winningAtTop')),
    vscode.commands.registerCommand('modbench.mod.sortLosingAtTop', () => show('losingAtTop')),
  ];
}

/** What the gesture answers its invoker: whether a mod landed. A cancelled picker, a cancelled
 *  name prompt and a refused install are one answer, since each leaves nothing installed. */
export interface InstallOutcome {
  installed: boolean;
}
const NOT_INSTALLED: InstallOutcome = { installed: false };

export interface ModInstallDeps {
  instanceRoot: string;
  instance: Pick<Instance, 'value'>;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string, validate?: (value: string) => string | undefined) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}

interface SourceKindItem extends vscode.QuickPickItem {
  sourceKind: 'archive' | 'folder';
}

// modbench.mod.install: the Mods menu supplies no source, so it asks archive-or-folder first,
// before either OS picker opens (mods.md, Create empty mod and install, story 2).
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { instanceRoot, instance, runModAction, promptModName, warnIfFomod } = deps;
  const validateName = (name: string) => collidingModName(instance, name);
  const installArchive = async (archivePath: string): Promise<InstallOutcome> => {
    const name = await promptModName(defaultModName(archivePath), validateName);
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runModAction('installFromArchive', `Failed to install "${name}".`, async () => {
      const outcome = await installFromArchive(
        instanceRoot, { kind: 'new', name }, archivePath, { gameName: instance.value.gameRelease });
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      succeeded = true;
    });
    return { installed: succeeded };
  };
  const installFolder = async (folder: string): Promise<InstallOutcome> => {
    const name = await promptModName(path.basename(folder), validateName);
    if (!name) return NOT_INSTALLED;
    let succeeded = false;
    await runModAction('installFromFolder', `Failed to install "${name}".`, async () => {
      const outcome = await installFromFolder(instanceRoot, { kind: 'new', name }, folder, { gameName: instance.value.gameRelease });
      if (!outcome.applied) throw new Error(outcome.refusal);
      warnIfFomod(name, outcome.isFomod);
      succeeded = true;
    });
    return { installed: succeeded };
  };
  return [
    vscode.commands.registerCommand('modbench.mod.install', async (): Promise<InstallOutcome> => {
      const picked = await vscode.window.showQuickPick<SourceKindItem>(
        [
          { label: 'Archive…', description: 'A .zip, .7z or .rar file', sourceKind: 'archive' },
          { label: 'Folder…', description: 'An already-extracted mod folder', sourceKind: 'folder' },
        ],
        { placeHolder: 'Install a mod from an archive or a folder' },
      );
      if (!picked) return NOT_INSTALLED;
      if (picked.sourceKind === 'archive') {
        const archivePicked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Mod archives': [...ARCHIVE_EXTENSIONS] },
          openLabel: 'Install',
        });
        const archive = archivePicked?.[0]?.fsPath;
        return archive ? installArchive(archive) : NOT_INSTALLED;
      }
      const folderPicked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Install',
      });
      const folder = folderPicked?.[0]?.fsPath;
      return folder ? installFolder(folder) : NOT_INSTALLED;
    }),
  ];
}
// modbench.mod.enable / modbench.mod.disable: the whole selection through the entry (mods.md,
// Menus and keys, story 3). Each mod lands on its own (commands.md, "A selection is one gesture").
export function registerModEnableCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  const run = (enabled: boolean) => async (entry: GestureEntry) => {
    const modNames = pluralArgument(entry, 'mod').map((n) => n.mod.name);
    if (modNames.length === 0) return;
    const verb = enabled ? 'enable' : 'disable';
    const profile = instance.value.activeProfile;
    const result = await setModsEnabled(instanceRoot, profile, modNames, enabled);
    if (!result.applied) {
      reporter.report('error', `Failed to ${verb} mods.`, result.refusal);
      return;
    }
    reporter.selectionOutcome(
      `Could not ${verb} ${result.outcome.refused.length} of ${modNames.length} mods.`,
      result.outcome, (name) => name,
    );
  };
  return [
    registerModsGesture('modbench.mod.enable', viewSelection, run(true)),
    registerModsGesture('modbench.mod.disable', viewSelection, run(false)),
  ];
}

/** What the move asks of the Mods view: its selection, and the direction its pick follows. */
export interface MoveView {
  selection: () => readonly ModlistNode[];
  direction: () => SortDirection;
}

const SEPARATOR_PLACES =
  'A separator lands beside another separator or at an end of mod order, never beside a mod or among the ungrouped mods.';

export function registerModMoveCommand(
  instanceRoot: string, instance: Pick<Instance, 'value'>, view: MoveView, reporter: Reporter,
): vscode.Disposable {
  const report = (kind: 'mod' | 'separator', count: number, result: ModlistSelectionResult) => {
    const noun = `${kind}s`;
    if (!result.applied) {
      reporter.report('error', `Failed to move ${noun}.`, result.refusal);
      return;
    }
    reporter.selectionOutcome(
      `Could not move ${result.outcome.refused.length} of ${count} ${noun}.`, result.outcome, (name) => name);
  };
  return registerModsGesture('modbench.mod.move', view.selection, async (entry, option) => {
    const rows = pluralArgument(entry, 'mod', 'separator');
    const modNames = rows.flatMap((row) => (row.kind === 'mod' ? [row.mod.name] : []));
    const separatorNames = rows.flatMap((row) => (row.kind === 'separator' ? [row.separator.name] : []));
    const { mods: entries, activeProfile } = instance.value;
    const direction = view.direction();
    const given = moveTargetOf(option);
    const pick = async <T extends MovePlace>(items: MovePickItem<T>[], placeHolder: string) => {
      const picked = await vscode.window.showQuickPick(items, { placeHolder });
      return picked && { place: picked.target, end: endAtTop(direction) };
    };
    if (modNames.length > 0 && separatorNames.length === 0) {
      const target = given ?? await pick(modsMovePick(entries, direction, modNames), 'Move to…');
      if (!target) return;
      report('mod', modNames.length, await moveMods(instanceRoot, activeProfile, modNames, target.place, target.end));
    } else if (separatorNames.length > 0 && modNames.length === 0) {
      const target = given ?? await pick(separatorsMovePick(entries, direction, separatorNames), 'Move above…');
      if (!target) return;
      if (!isSeparatorsPlace(target.place)) {
        reporter.report('error', 'Failed to move separators.', SEPARATOR_PLACES);
        return;
      }
      report('separator', separatorNames.length,
        await moveSeparators(instanceRoot, activeProfile, separatorNames, target.place, target.end));
    }
  });
}

export function registerModContextCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
  ask: AskQuestion,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.mod.uninstall', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        const answer = await ask(
          `Uninstall "${node.mod.name}"? This will permanently delete the mod folder from disk.`,
          { modal: true },
          'Uninstall',
        );
        if (answer !== 'Uninstall') return;
        await runModAction('uninstall', `Failed to uninstall "${node.mod.name}".`, async () => {
          const profile = instance.value.activeProfile;
          // The download to mark comes off the row the tree already holds, so the command walks
          // nothing to find it.
          applyOrThrow(await uninstallMod(instanceRoot, profile, node.mod.name, node.mod.archiveFilename));
        });
      }),
  ];
}
export function registerSeparatorCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
  viewSelection: () => readonly ModlistNode[],
): vscode.Disposable[] {
  return [
      registerModsGesture('modbench.separator.rename', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'separator');
        if (!node) return;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename separator',
          value: node.separator.name,
        });
        if (!newName || newName === node.separator.name) return;
        await runModAction('renameSeparator', 'Failed to rename separator.', async () => {
          const profile = instance.value.activeProfile;
          applyOrThrow(await renameSeparator(instanceRoot, profile, node.separator.name, newName));
        });
      }),
      registerModsGesture('modbench.separator.add', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'mod', 'separator');
        if (!node) return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('addSeparator', 'Failed to add separator.', async () => {
          const profile = instance.value.activeProfile;
          const anchorName = node.kind === 'mod' ? node.mod.name : node.separator.name;
          applyOrThrow(await insertSeparator(instanceRoot, profile, name, anchorName));
        });
      }),
      vscode.commands.registerCommand('modbench.separator.delete', async (node: SeparatorNode | undefined) => {
        if (node?.kind !== 'separator') return;
        await runModAction('deleteSeparator', 'Failed to delete separator.', async () => {
          const profile = instance.value.activeProfile;
          applyOrThrow(await deleteSeparator(instanceRoot, profile, node.separator.name));
        });
      }),
  ];
}
export function registerCreateEmptyModCommand(
  instanceRoot: string, instance: Pick<Instance, 'value'>, reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.createEmpty', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'New mod name', placeHolder: 'My New Mod',
      validateInput: (value) => collidingModName(instance, value),
    });
    if (!name) return;
    try {
      const profile = instance.value.activeProfile;
      const outcome = await createEmptyMod(instanceRoot, profile, name, instance.value.modFolders ?? []);
      applyOrThrow(outcome);
      if (outcome.lineRefusal !== undefined) {
        reporter.report(
          'warning', `"${name}" was created, but its modlist.txt line could not be written.`, outcome.lineRefusal);
      }
    } catch (err) {
      reporter.report('error', `Failed to create "${name}".`, errorMessage(err));
    }
  });
}

/** A mod row opens the mod's folder, and the Overwrite row the overwrite folder. */
export function registerOpenFolderCommand(instance: Pick<Instance, 'value'>, reporter: Reporter): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.openFolder', async (node: ModNode | OverwriteNode | undefined) => {
    const target = node && folderOf(instance, node);
    if (!target) return;
    await reportFailure(reporter, `Failed to open the folder of "${target.name}".`, async () => {
      await vscode.commands.executeCommand('revealInExplorer', target.folder);
    });
  });
}

export async function reportFailure(reporter: Reporter, failMessage: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    reporter.report('error', failMessage, errorMessage(err));
  }
}

// The value's own folder for a mod row, never a path joined here: the Instance adapter owns every
// path function, and the value carries its answer.
function folderOf(
  instance: Pick<Instance, 'value'>, node: ModNode | OverwriteNode,
): { name: string; folder: vscode.Uri } | undefined {
  if (node.kind === OVERWRITE_NODE_KIND) return { name: 'Overwrite', folder: vscode.Uri.file(instance.value.paths.overwriteDir) };
  const folder = instance.value.paths.modDirs.get(node.mod.name);
  return folder === undefined ? undefined : { name: node.mod.name, folder: vscode.Uri.file(folder) };
}

/** The Argument of view on Nexus. Each surface's row adapts itself to it, so a mod row and a
 *  downloaded file row reach the same gesture. */
export interface NexusModRow {
  readonly nexusModId?: string;
}

export function registerViewOnNexusCommand(instance: Pick<Instance, 'value'>, reporter: Reporter): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.viewOnNexus', async (row: NexusModRow | undefined) => {
    const nexusModId = row?.nexusModId;
    if (!nexusModId) return;
    await reportFailure(reporter, `Failed to open the Nexus page of mod ${nexusModId}.`, async () => {
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://www.nexusmods.com/${instance.value.nexusSlug}/mods/${nexusModId}`));
    });
  });
}

function isModlistEntryNode(node: unknown): node is ModNode | SeparatorNode {
  return node instanceof ModNode || node instanceof SeparatorNode;
}

function copyValueRowNames(rows: readonly (ModNode | SeparatorNode)[]): string {
  return rows.map((row) => (row.kind === 'mod' ? row.mod.name : row.separator.name)).join('\n');
}

/** Mods' own text for the catalog's one copy value id (mods.md, Menus and keys, story 7).
 *  `undefined` unless `clicked` is a mod or separator row — a keyless invocation defers to the
 *  next adapter. */
export function modsCopyValueText(
  viewSelection: () => readonly ModlistNode[],
): (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined {
  return (clicked, allSelected) => {
    if (!isModlistEntryNode(clicked)) return undefined;
    const selected = allSelected?.length ? allSelected.filter(isModlistEntryNode) : undefined;
    return copyValueRowNames(selectionArgument(modsGestureEntry(clicked, selected, viewSelection), 'mod', 'separator'));
  };
}
