import * as vscode from 'vscode';
import { OVERWRITE_LABEL } from '../instanceLoader/fileConflictIndex';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import type { ModlistNode } from './ModListProvider';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import type { NexusModRow } from '../drivingLib/inFocusedView';
import { isModsKeyArgs, isRowOf, runModsWriting, openFolderArgument } from './gestureEntry';
import {
  gestureEntry, pluralArgument, registerGesture, selectionArgument, singularArgument, type GestureEntry, type RowOf,
} from '../drivingLib/gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import {
  createEmptyMod,
  deleteSeparators,
  insertSeparator,
  markFiles,
  moveMods,
  moveSeparators,
  renameMod,
  renameSeparator,
  setModsEnabled,
  uninstallMods,
  renameModNameRefusal,
  separatorNameRefusal,
  type ModlistAccess,
  type ModlistSelectionResult,
  type MovePlace,
  type OriginFileMark,
} from '../modlist/modlist';
import { FILE_MARKS, fileLabel } from './modFiles';
import { endAtTop, isSeparatorsPlace, onlyCurrent, modsMovePick, moveTargetOf, separatorsMovePick, type MovePickItem } from './movePick';
import { installNameRefusal } from '../install/install';
import { errorMessage } from '../ports/errorMessage';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { reportFailure } from '../drivingLib/reportFailure';
import { applyOrThrow } from '../ports/applyOrThrow';

// modbench.mod.enable / modbench.mod.disable: the whole selection through the entry (mods.md,
// Menus and keys, story 3). Each mod lands on its own (commands.md, "A selection is one gesture").
export function registerModEnableCommands(
  access: ModlistAccess, instance: Pick<Instance, 'value' | 'refresh'>,
  viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  const run = (enabled: boolean) => (entry: GestureEntry<ModlistNode>) => {
    const modNames = pluralArgument(entry, 'mod').map((n) => n.mod.name);
    if (modNames.length === 0) return;
    const verb = enabled ? 'enable' : 'disable';
    return runModsWriting(instance, async () => {
      const result = await setModsEnabled(access, instance.value.activeProfile, modNames, enabled);
      if (!result.applied) {
        reporter.report('error', `Failed to ${verb} mods.`, result.refusal);
        return;
      }
      reporter.selectionOutcome(
        `Could not ${verb} ${result.outcome.refused.length} of ${modNames.length} mods.`,
        result.outcome, (name) => name,
      );
    });
  };
  return [
    registerGesture('modbench.mod.enable', viewSelection, run(true)),
    registerGesture('modbench.mod.disable', viewSelection, run(false)),
  ];
}

// modbench.mod.excludeFile / modbench.mod.includeFile: the direction is the command's, so a mixed
// selection takes the right-clicked row's (mods.md, Menus and keys, story 7).
export function registerFileExclusionCommands(
  access: ModlistAccess, instance: Pick<Instance, 'refresh'>, viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  const run = (mark: OriginFileMark) => (entry: GestureEntry<ModlistNode>) => {
    const rows = pluralArgument(entry, 'file');
    if (rows.length === 0) return;
    const { verb } = FILE_MARKS[mark];
    const refs = rows.map((row) => row.ref);
    return runModsWriting(instance, async () => {
      const outcome = await markFiles(access, refs, mark);
      reporter.selectionOutcome(`Could not ${verb} ${outcome.refused.length} of ${refs.length} files.`, outcome, fileLabel);
    });
  };
  return [
    registerGesture('modbench.mod.excludeFile', viewSelection, run('Excluded')),
    registerGesture('modbench.mod.includeFile', viewSelection, run('Included')),
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
  access: ModlistAccess, instance: Pick<Instance, 'value' | 'refresh'>, view: MoveView, reporter: Reporter,
): vscode.Disposable {
  const report = (kind: 'mod' | 'separator', names: readonly string[], result: ModlistSelectionResult) => {
    const noun = `${kind}s`;
    if (!result.applied) {
      reporter.report('error', `Failed to move ${noun}.`, result.refusal);
      return;
    }
    reporter.selectionOutcome(
      `Could not move ${result.outcome.refused.length} of ${names.length} ${noun}.`, result.outcome, (name) => name);
  };
  return registerGesture('modbench.mod.move', view.selection, async (entry, option) => {
    const rows = pluralArgument(entry, 'mod', 'separator');
    const modNames = rows.flatMap((row) => (row.kind === 'mod' ? [row.mod.name] : []));
    const separatorNames = rows.flatMap((row) => (row.kind === 'separator' ? [row.separator.name] : []));
    const { mods: entries, activeProfile } = instance.value;
    const direction = view.direction();
    const given = moveTargetOf(option);
    const pick = async <T extends MovePlace>(items: MovePickItem<T>[], placeholder: string) => {
      const picked = await pickWithMarked(items, onlyCurrent(items), placeholder);
      return picked && { place: picked.target, end: endAtTop(direction) };
    };
    if (modNames.length > 0 && separatorNames.length === 0) {
      const target = given ?? await pick(modsMovePick(entries, direction, modNames), 'Move to…');
      if (!target) return;
      await runModsWriting(instance, async () =>
        report('mod', modNames, await moveMods(access, activeProfile, modNames, target.place, target.end)));
    } else if (separatorNames.length > 0 && modNames.length === 0) {
      const target = given ?? await pick(separatorsMovePick(entries, direction, separatorNames), 'Move above…');
      if (!target) return;
      const { place, end } = target;
      if (!isSeparatorsPlace(place)) {
        reporter.report('error', 'Failed to move separators.', SEPARATOR_PLACES);
        return;
      }
      await runModsWriting(instance, async () =>
        report('separator', separatorNames, await moveSeparators(access, activeProfile, separatorNames, place, end)));
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

export interface ModContextDeps {
  access: ModlistAccess;
  instance: Pick<Instance, 'value' | 'refresh'>;
  viewSelection: () => readonly ModlistNode[];
  reporter: Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  log: (line: string) => void;
}

export function registerModContextCommands(
  { access, instance, viewSelection, reporter, ask, trash, log }: ModContextDeps,
): vscode.Disposable[] {
  return [
      registerGesture('modbench.mod.rename', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'mod');
        if (!node) return;
        const oldName = node.mod.name;
        const newName = await promptRename('Rename mod', oldName, modNamePrompt(access, instance, oldName));
        if (newName === undefined) return;
        await runModsWriting(instance, async () => {
          const { activeProfile, profiles, managerNames } = instance.value;
          const result = await renameMod(access, activeProfile, profiles, oldName, newName);
          if (!result.applied) {
            reporter.report('error', 'Failed to rename mod.', result.refusal);
            return;
          }
          for (const { profile, refusal } of result.lineRefusals) {
            reporter.report('warning',
              `"${oldName}" was renamed, but its ${managerNames.modOrderFile} line in profile "${profile}" could not be renamed.`, refusal);
          }
        });
      }),
      registerGesture('modbench.mod.uninstall', viewSelection, async (entry) => {
        // The download to mark comes off the row the tree already holds, so the command walks
        // nothing to find it.
        const mods = pluralArgument(entry, 'mod').map((n) => ({ name: n.mod.name, archiveFilename: n.mod.archiveFilename }));
        if (mods.length === 0) return;
        if (!(await confirmUninstall(mods.map((m) => m.name), ask))) return;
        await runModsWriting(instance, async () => {
          const result = await uninstallMods(access, instance.value.activeProfile, mods, trash);
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
        });
      }),
  ];
}
function separatorNamePrompt(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, own?: string,
): (value: string) => Promise<string | undefined> {
  return async (value) => (value === '' ? undefined : separatorNameRefusal(access, instance.value.activeProfile, value, own));
}

function modNamePrompt(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, own: string,
): (value: string) => Promise<string | undefined> {
  return async (value) => (value === '' ? undefined : renameModNameRefusal(access, instance.value.activeProfile, value, own));
}

async function confirmSeparatorDelete(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const question = names.length === 1
    ? `Delete separator "${names[0]}"? Its mods stay.`
    : `Delete separators ${names.map((n) => `"${n}"`).join(', ')}? Their mods stay.`;
  return (await ask(question, { modal: true }, 'Delete')) === 'Delete';
}

/** The new name for a row, prefilled with the current one; undefined on Esc, an empty name or the same name. */
export async function promptRename(
  prompt: string, oldName: string, validateInput: NonNullable<vscode.InputBoxOptions['validateInput']>,
): Promise<string | undefined> {
  const newName = await vscode.window.showInputBox({ prompt, value: oldName, validateInput });
  return !newName || newName === oldName ? undefined : newName;
}

export function registerSeparatorCommands(
  access: ModlistAccess, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
  viewSelection: () => readonly ModlistNode[],
): vscode.Disposable[] {
  return [
      registerGesture('modbench.separator.rename', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'separator');
        if (!node) return;
        const oldName = node.separator.name;
        const newName = await promptRename('Rename separator', oldName, separatorNamePrompt(access, instance, oldName));
        if (newName === undefined) return;
        await runModsWriting(instance, () => reportFailure(reporter, 'Failed to rename separator.', async () => {
          applyOrThrow(await renameSeparator(access, instance.value.activeProfile, oldName, newName));
        }));
      }),
      registerGesture('modbench.separator.add', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'mod', 'separator');
        if (!node) return;
        const name = await vscode.window.showInputBox({
          prompt: 'Separator name', placeHolder: 'My Group', validateInput: separatorNamePrompt(access, instance),
        });
        if (!name) return;
        const anchor = node.kind === 'mod' ? node.mod : node.separator;
        await runModsWriting(instance, () => reportFailure(reporter, 'Failed to add separator.', async () => {
          applyOrThrow(await insertSeparator(
            access, instance.value.activeProfile, name, { kind: anchor.kind, name: anchor.name }));
        }));
      }),
      registerGesture('modbench.separator.delete', viewSelection, async (entry) => {
        const names = pluralArgument(entry, 'separator').map((n) => n.separator.name);
        if (names.length === 0) return;
        if (!(await confirmSeparatorDelete(names, ask))) return;
        await runModsWriting(instance, async () => {
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
        });
      }),
  ];
}
export function registerCreateEmptyModCommand(
  access: ModlistAccess, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.createEmpty', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'New mod name', placeHolder: 'My New Mod',
      validateInput: (value) => installNameRefusal(access, value),
    });
    if (!name) return;
    await runModsWriting(instance, async () => {
      try {
        const outcome = await createEmptyMod(access, instance.value.activeProfile, name);
        applyOrThrow(outcome);
        if (outcome.lineRefusal !== undefined) {
          reporter.report(
            'warning', `"${name}" was created, but its ${instance.value.managerNames.modOrderFile} line could not be written.`, outcome.lineRefusal);
        }
      } catch (err) {
        reporter.report('error', `Failed to create "${name}".`, errorMessage(err));
      }
    });
  });
}

/** A mod row opens the mod's folder, the Overwrite row the overwrite folder, and a file or folder
 *  row shows itself where it sits. */
export function registerOpenFolderCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable {
  return registerGesture('modbench.mod.openFolder', viewSelection, async (entry) => {
    const anchor = openFolderArgument(entry);
    if (anchor === undefined) return;
    const target = folderOf(instance, anchor);
    await reportFailure(reporter, `Failed to open the folder of "${target.name}".`, async () => {
      if (target.folder === undefined) throw new Error('No folder holds it.');
      await vscode.commands.executeCommand('revealInExplorer', target.folder);
    });
  });
}

// The value's own path for each row, never a path joined here: the Instance adapter owns every
// path function, and the value carries its answer.
function folderOf(
  instance: Pick<Instance, 'value'>, node: NonNullable<ReturnType<typeof openFolderArgument>>,
): { name: string; folder: vscode.Uri | undefined } {
  const { overwriteDir, modDirs } = instance.value.paths;
  const uriOf = (path: string | undefined) => (path === undefined ? undefined : vscode.Uri.file(path));
  switch (node.kind) {
    case OVERWRITE_ORIGIN: return { name: OVERWRITE_LABEL, folder: uriOf(overwriteDir) };
    case 'mod': return { name: node.mod.name, folder: uriOf(modDirs.get(node.mod.name)) };
    case 'folder': return { name: node.folder.relativePath, folder: uriOf(node.folder.path) };
    case 'file': return { name: node.file.relativePath, folder: uriOf(node.file.path) };
  }
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

const COPY_KINDS = ['mod', 'separator', 'folder', 'file'] as const;

const isCopyRow = isRowOf(COPY_KINDS);

function copyValueOf(row: RowOf<ModlistNode, typeof COPY_KINDS[number]>): string {
  switch (row.kind) {
    case 'mod': return row.mod.name;
    case 'separator': return row.separator.name;
    case 'folder': return row.folder.relativePath;
    case 'file': return row.file.relativePath;
  }
}

const copyValueLines = (entry: GestureEntry<ModlistNode>): string => selectionArgument(entry, ...COPY_KINDS).map(copyValueOf).join('\n');

/** Mods' own text for the catalog's one copy value id. `undefined` unless `clicked` is a row copy
 *  value takes or the Mods key's args, so the palette and another view's key defer. */
export function modsCopyValueText(
  viewSelection: () => readonly ModlistNode[],
): (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined {
  return (clicked, allSelected) => {
    if (isModsKeyArgs(clicked)) return copyValueLines({ selection: viewSelection() });
    if (!isCopyRow(clicked)) return undefined;
    const selected = allSelected?.length ? allSelected.filter(isCopyRow) : undefined;
    return copyValueLines(gestureEntry(clicked, selected, viewSelection));
  };
}
