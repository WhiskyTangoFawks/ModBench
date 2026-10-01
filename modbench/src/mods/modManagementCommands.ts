import * as vscode from 'vscode';
import { ModListProvider, ModNode, OverwriteNode, OVERWRITE_NODE_KIND, SeparatorNode, type ModlistNode, type SortDirection } from './ModListProvider';
import {
  isModsKeyArgs, modsGestureEntry, pluralArgument, registerModsGesture, selectionArgument, singularArgument, type GestureEntry,
} from './gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import {
  createEmptyMod,
  deleteSeparators,
  insertSeparator,
  moveMods,
  moveSeparators,
  renameSeparator,
  setModsEnabled,
  uninstallMods,
  separatorNameRefusal,
  type ModlistAccess,
  type ModlistSelectionResult,
  type MovePlace,
} from '../modlist/modlist';
import { endAtTop, isSeparatorsPlace, modsMovePick, moveTargetOf, separatorsMovePick, type MovePickItem } from './movePick';
import { installNameRefusal } from '../install/install';
import { errorMessage } from '../ports/errorMessage';
import { applyOrThrow } from '../ports/applyOrThrow';

/** The Mods tree's view direction writes no instance file, so it lives with the view it flips. It
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

// modbench.mod.enable / modbench.mod.disable: the whole selection through the entry (mods.md,
// Menus and keys, story 3). Each mod lands on its own (commands.md, "A selection is one gesture").
export function registerModEnableCommands(
  access: ModlistAccess, instance: Pick<Instance, 'value'>,
  viewSelection: () => readonly ModlistNode[], reporter: Reporter,
  marks: Pick<ModListProvider, 'isEnabled' | 'markUnconfirmed' | 'forgetUnconfirmed'>,
): vscode.Disposable[] {
  const run = (enabled: boolean) => async (entry: GestureEntry) => {
    const rows = pluralArgument(entry, 'mod');
    if (rows.length === 0) return;
    const modNames = rows.map((n) => n.mod.name);
    const changing = rows.filter((row) => marks.isEnabled(row) !== enabled).map((row) => row.mod.name);
    for (const name of changing) marks.markUnconfirmed(name, enabled);
    const verb = enabled ? 'enable' : 'disable';
    const profile = instance.value.activeProfile;
    const result = await setModsEnabled(access, profile, modNames, enabled);
    if (!result.applied) {
      reporter.report('error', `Failed to ${verb} mods.`, result.refusal);
      for (const name of changing) marks.forgetUnconfirmed(name);
      return;
    }
    reporter.selectionOutcome(
      `Could not ${verb} ${result.outcome.refused.length} of ${modNames.length} mods.`,
      result.outcome, (name) => name,
    );
    for (const { item } of result.outcome.refused) marks.forgetUnconfirmed(item);
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
  access: ModlistAccess, instance: Pick<Instance, 'value'>, view: MoveView, reporter: Reporter,
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
      report('mod', modNames.length, await moveMods(access, activeProfile, modNames, target.place, target.end));
    } else if (separatorNames.length > 0 && modNames.length === 0) {
      const target = given ?? await pick(separatorsMovePick(entries, direction, separatorNames), 'Move above…');
      if (!target) return;
      if (!isSeparatorsPlace(target.place)) {
        reporter.report('error', 'Failed to move separators.', SEPARATOR_PLACES);
        return;
      }
      report('separator', separatorNames.length,
        await moveSeparators(access, activeProfile, separatorNames, target.place, target.end));
    }
  });
}

// One question for the whole selection: naming the mod alone, or listing several, both saying
// where the folders go (mods.md, Uninstall).
async function confirmUninstall(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const [only] = names;
  const question = names.length === 1 && only !== undefined
    ? `Uninstall "${only}"? Its folder will be moved to the system trash.`
    : `Uninstall ${names.map((n) => `"${n}"`).join(', ')}? Their folders will be moved to the system trash.`;
  return (await ask(question, { modal: true }, 'Uninstall')) === 'Uninstall';
}

export function registerModContextCommands(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, viewSelection: () => readonly ModlistNode[],
  reporter: Reporter, ask: AskQuestion, trash: MoveToTrash, log: (line: string) => void,
): vscode.Disposable[] {
  return [
      registerModsGesture('modbench.mod.uninstall', viewSelection, async (entry) => {
        // The download to mark comes off the row the tree already holds, so the command walks
        // nothing to find it.
        const mods = pluralArgument(entry, 'mod').map((n) => ({ name: n.mod.name, archiveFilename: n.mod.archiveFilename }));
        if (mods.length === 0) return;
        if (!(await confirmUninstall(mods.map((m) => m.name), ask))) return;
        const profile = instance.value.activeProfile;
        const result = await uninstallMods(access, profile, mods, trash);
        if (!result.applied) {
          reporter.report('error', 'Failed to uninstall mods.', result.refusal);
          return;
        }
        reporter.selectionOutcome(
          `Could not uninstall ${result.outcome.refused.length} of ${mods.length} mods.`, result.outcome, (m) => m.name);
        for (const item of result.outcome.landed) {
          if (item.lineRefusal !== undefined) {
            reporter.report('warning',
              `"${item.name}" was uninstalled, but its ${instance.value.managerNames.modOrderFile} line could not be removed.`, item.lineRefusal);
          } else if (item.markRefusal !== undefined) {
            log(`"${item.name}" was uninstalled, but its downloaded file could not be marked uninstalled: ${item.markRefusal}`);
          }
        }
      }),
  ];
}
function separatorNamePrompt(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, own?: string,
): (value: string) => Promise<string | undefined> {
  return async (value) => (value === '' ? undefined : separatorNameRefusal(access, instance.value.activeProfile, value, own));
}

export function registerSeparatorCommands(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, reporter: Reporter, trash: MoveToTrash,
  viewSelection: () => readonly ModlistNode[], marks: Pick<ModListProvider, 'markUnconfirmedRename' | 'forgetUnconfirmedRename'>,
): vscode.Disposable[] {
  return [
      registerModsGesture('modbench.separator.rename', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'separator');
        if (!node) return;
        const oldName = node.separator.name;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename separator', value: oldName, validateInput: separatorNamePrompt(access, instance, oldName),
        });
        if (!newName || newName === oldName) return;
        marks.markUnconfirmedRename(oldName, newName);
        await reportFailure(reporter, 'Failed to rename separator.', async () => {
          try {
            applyOrThrow(await renameSeparator(access, instance.value.activeProfile, oldName, newName));
          } catch (err) {
            marks.forgetUnconfirmedRename(newName);
            throw err;
          }
        });
      }),
      registerModsGesture('modbench.separator.add', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'mod', 'separator');
        if (!node) return;
        const name = await vscode.window.showInputBox({
          prompt: 'Separator name', placeHolder: 'My Group', validateInput: separatorNamePrompt(access, instance),
        });
        if (!name) return;
        const anchor = node.kind === 'mod' ? node.mod : node.separator;
        await reportFailure(reporter, 'Failed to add separator.', async () => {
          applyOrThrow(await insertSeparator(
            access, instance.value.activeProfile, name, { kind: anchor.kind, name: anchor.name }));
        });
      }),
      registerModsGesture('modbench.separator.delete', viewSelection, async (entry) => {
        const names = pluralArgument(entry, 'separator').map((n) => n.separator.name);
        if (names.length === 0) return;
        const result = await deleteSeparators(access, instance.value.activeProfile, names, trash);
        if (!result.applied) {
          reporter.report('error', 'Failed to delete separators.', result.refusal);
          return;
        }
        reporter.selectionOutcome(
          `Could not delete ${result.outcome.refused.length} of ${names.length} separators.`,
          result.outcome, (item) => item.name);
        for (const item of result.outcome.landed) {
          if (item.lineRefusal !== undefined) {
            reporter.report('warning',
              `"${item.name}" was deleted, but its ${instance.value.managerNames.modOrderFile} line could not be removed.`, item.lineRefusal);
          }
        }
      }),
  ];
}
export function registerCreateEmptyModCommand(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.createEmpty', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'New mod name', placeHolder: 'My New Mod',
      validateInput: (value) => installNameRefusal(access, value),
    });
    if (!name) return;
    try {
      const profile = instance.value.activeProfile;
      const outcome = await createEmptyMod(access, profile, name);
      applyOrThrow(outcome);
      if (outcome.lineRefusal !== undefined) {
        reporter.report(
          'warning', `"${name}" was created, but its ${instance.value.managerNames.modOrderFile} line could not be written.`, outcome.lineRefusal);
      }
    } catch (err) {
      reporter.report('error', `Failed to create "${name}".`, errorMessage(err));
    }
  });
}

/** A mod row opens the mod's folder, and the Overwrite row the overwrite folder. */
export function registerOpenFolderCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable {
  return registerModsGesture('modbench.mod.openFolder', viewSelection, async (entry) => {
    const anchor = entry.clicked ?? entry.focused;
    if (!(anchor instanceof ModNode || anchor instanceof OverwriteNode)) return;
    const target = folderOf(instance, anchor);
    await reportFailure(reporter, `Failed to open the folder of "${target.name}".`, async () => {
      if (target.folder === undefined) throw new Error('No folder holds it.');
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
): { name: string; folder: vscode.Uri | undefined } {
  const { overwriteDir, modDirs } = instance.value.paths;
  const [name, folder] = node.kind === OVERWRITE_NODE_KIND ? ['Overwrite', overwriteDir] : [node.mod.name, modDirs.get(node.mod.name)];
  return { name, folder: folder === undefined ? undefined : vscode.Uri.file(folder) };
}

/** The Argument of view on Nexus. Each surface's row adapts itself to it, so a mod row and a
 *  downloaded file row reach the same gesture. */
export interface NexusModRow {
  readonly nexusModId?: string;
}

/** `selectedRow` is the palette's Argument, which hands the command no row. */
export function registerViewOnNexusCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, selectedRow: () => NexusModRow | undefined,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.viewOnNexus', async (row: NexusModRow | undefined) => {
    const nexusModId = (row ?? selectedRow())?.nexusModId;
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

/** Mods' own text for the catalog's one copy value id. `undefined` unless `clicked` is a mod or
 *  separator row or the Mods key's args, so the palette and another view's key defer. */
export function modsCopyValueText(
  viewSelection: () => readonly ModlistNode[],
): (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined {
  return (clicked, allSelected) => {
    if (isModsKeyArgs(clicked)) return copyValueRowNames(selectionArgument({ selection: viewSelection() }, 'mod', 'separator'));
    if (!isModlistEntryNode(clicked)) return undefined;
    const selected = allSelected?.length ? allSelected.filter(isModlistEntryNode) : undefined;
    return copyValueRowNames(selectionArgument(modsGestureEntry(clicked, selected, viewSelection), 'mod', 'separator'));
  };
}
