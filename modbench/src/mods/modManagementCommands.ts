import * as vscode from 'vscode';
import { OVERWRITE_LABEL } from '../instanceLoader/fileConflictIndex';
import type { ModlistNode } from './ModListProvider';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import type { NexusModRow } from '../drivingLib/inFocusedView';
import { promptRename } from '../drivingLib/promptRename';
import { MODS_KEY_ARGS, fileRefOf, modNameOf, runModsWriting, openFolderArgument } from './gestureEntry';
import { registerAgentGesture, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { viewCopyValueText } from '../drivingLib/copyValue';
import {
  pluralArgument, registerGesture, singularArgument, type RowOf,
} from '../drivingLib/gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import type { ModlistCommands, MovePlace, OriginFileMark, OriginFileRef, SelectionResult } from '../modOrderCommands/modOrderCommands';
import { FILE_MARKS, fileLabel } from './modFiles';
import {
  endAtTop, isSeparatorsPlace, onlyCurrent, modsMovePick, moveTargetOf, separatorsMovePick, type MovePickItem, type MoveTarget,
} from './movePick';
import { errorMessage } from '../ports/errorMessage';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { reportFailure } from '../drivingLib/reportFailure';
import { Refusal } from '../drivingLib/refusal';

// modbench.mod.enable / modbench.mod.disable: the whole selection through the entry (mods.md,
// Menus and keys, story 3). Each mod lands on its own (commands.md, "A selection is one gesture").
export function registerModEnableCommands(
  commands: ModlistCommands, instance: Pick<Instance, 'value' | 'refresh'>,
  viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  const gesture = (enabled: boolean): AgentGesture<ModlistNode, readonly string[], SelectionResult<string>> => {
    const verb = enabled ? 'enable' : 'disable';
    return {
      fromView: (entry) => {
        const modNames = pluralArgument(entry, 'mod').map((n) => n.mod.name);
        return modNames.length === 0 ? undefined : modNames;
      },
      fromAgent: ({ argument }) => argument.map(modNameOf),
      run: (modNames) => runModsWriting(instance, () => commands.setModsEnabled(instance.value.activeProfile, modNames, enabled)),
      report: (result, modNames) => {
        if (!result.applied) {
          reporter.report('error', `Failed to ${verb} mods.`, result.refusal);
          return;
        }
        reporter.selectionOutcome(
          `Could not ${verb} ${result.outcome.refused.length} of ${modNames.length} mods.`,
          result.outcome, (name) => name,
        );
      },
    };
  };
  return [
    registerAgentGesture('modbench.mod.enable', viewSelection, gesture(true)),
    registerAgentGesture('modbench.mod.disable', viewSelection, gesture(false)),
  ];
}

// modbench.mod.excludeFile / modbench.mod.includeFile: the direction is the command's, so a mixed
// selection takes the right-clicked row's (mods.md, Menus and keys, story 7).
export function registerFileExclusionCommands(
  commands: ModlistCommands, instance: Pick<Instance, 'value' | 'refresh'>, viewSelection: () => readonly ModlistNode[], reporter: Reporter,
): vscode.Disposable[] {
  const gesture = (mark: OriginFileMark): AgentGesture<ModlistNode, readonly OriginFileRef[], GestureResult<OriginFileRef>> => {
    const { verb } = FILE_MARKS[mark];
    return {
      fromView: (entry) => {
        const refs = pluralArgument(entry, 'file').map((row) => row.ref);
        return refs.length === 0 ? undefined : refs;
      },
      fromAgent: ({ argument }) => argument.map(fileRefOf),
      run: async (refs) => {
        const result = await runModsWriting(instance, () => commands.markFiles(refs, mark, instance.value.paths.sourceDirs));
        return result.applied ? result : { applied: false, refusal: `Could not ${verb} ${refs.length} files.`, detail: result.refusal };
      },
      report: (result, refs) => {
        if (!result.applied) {
          reporter.report('error', result.refusal, result.detail);
          return;
        }
        reporter.selectionOutcome(`Could not ${verb} ${result.outcome.refused.length} of ${refs.length} files.`, result.outcome, fileLabel);
      },
    };
  };
  return [
    registerAgentGesture('modbench.mod.excludeFile', viewSelection, gesture('Excluded')),
    registerAgentGesture('modbench.mod.includeFile', viewSelection, gesture('Included')),
  ];
}

interface MoveView {
  selection: () => readonly ModlistNode[];
  direction: () => SortDirection;
}

const SEPARATOR_PLACES =
  'A separator lands beside another separator or at an end of mod order, never beside a mod or among the ungrouped mods.';

interface Move {
  readonly kind: 'mod' | 'separator';
  readonly names: readonly string[];
  readonly target: MoveTarget;
}

export function registerModMoveCommand(
  commands: ModlistCommands, instance: Pick<Instance, 'value' | 'refresh'>, view: MoveView, reporter: Reporter,
): vscode.Disposable {
  const failed = (kind: Move['kind'], detail: string): GestureResult<string> =>
    ({ applied: false, refusal: `Failed to move ${kind}s.`, detail });

  const asMoveResult = (kind: Move['kind'], result: SelectionResult<string>): GestureResult<string> =>
    result.applied ? result : failed(kind, result.refusal);

  const gesture: AgentGesture<ModlistNode, Move, GestureResult<string>, MoveTarget> = {
    fromView: async (entry, option) => {
      const rows = pluralArgument(entry, 'mod', 'separator');
      const modNames = rows.flatMap((row) => (row.kind === 'mod' ? [row.mod.name] : []));
      const separatorNames = rows.flatMap((row) => (row.kind === 'separator' ? [row.separator.name] : []));
      const { mods: entries } = instance.value;
      const direction = view.direction();
      const given = moveTargetOf(option);
      const pick = async <T extends MovePlace>(items: MovePickItem<T>[], placeholder: string) => {
        const picked = await pickWithMarked(items, onlyCurrent(items), placeholder);
        return picked && { place: picked.target, end: endAtTop(direction) };
      };
      if (modNames.length > 0 && separatorNames.length === 0) {
        const target = given ?? await pick(modsMovePick(entries, direction, modNames), 'Move to…');
        return target && { kind: 'mod', names: modNames, target };
      }
      if (separatorNames.length > 0 && modNames.length === 0) {
        const target = given ?? await pick(separatorsMovePick(entries, direction, separatorNames), 'Move above…');
        return target && { kind: 'separator', names: separatorNames, target };
      }
      return undefined;
    },
    fromAgent: ({ argument, options }) => ({ kind: 'mod', names: argument.map(modNameOf), target: options }),
    run: async ({ kind, names, target: { place, end } }) => {
      if (kind === 'mod') {
        if (place.kind === 'mod' && names.includes(place.name)) {
          return { applied: true, outcome: { landed: [], refused: names.map((item) => ({ item, reason: `The target is "${place.name}", which is moving.` })) } };
        }
        return runModsWriting(instance, async () => asMoveResult(kind, await commands.moveMods(instance.value.activeProfile, names, place, end)));
      }
      if (!isSeparatorsPlace(place)) return failed(kind, SEPARATOR_PLACES);
      return runModsWriting(instance, async () => asMoveResult(kind, await commands.moveSeparators(instance.value.activeProfile, names, place, end)));
    },
    report: (result, { kind, names }) => {
      if (!result.applied) {
        reporter.report('error', result.refusal, result.detail);
        return;
      }
      reporter.selectionOutcome(
        `Could not move ${result.outcome.refused.length} of ${names.length} ${kind}s.`, result.outcome, (name) => name);
    },
  };
  return registerAgentGesture('modbench.mod.move', view.selection, gesture);
}

// One question for the whole selection: naming the mod alone, or listing several, both saying
// where the folders go (mods.md, Uninstall).
async function confirmUninstall(names: readonly string[], sourceMods: readonly string[], ask: AskQuestion): Promise<boolean> {
  const [only] = names;
  const quoted = (list: readonly string[]) => list.map((n) => `"${n}"`).join(', ');
  const question = names.length === 1 && only !== undefined
    ? `Uninstall "${only}"? Its folder${sourceMods.length > 0 ? ' and its source' : ''} will be moved to the system trash.`
    : `Uninstall ${quoted(names)}? Their folders will be moved to the system trash${
      sourceMods.length > 0 ? `, and the source of ${quoted(sourceMods)} with them` : ''}.`;
  return (await ask(question, { modal: true }, 'Uninstall')) === 'Uninstall';
}

interface ModContextDeps {
  commands: ModlistCommands;
  instance: Pick<Instance, 'value' | 'refresh'>;
  viewSelection: () => readonly ModlistNode[];
  reporter: Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  log: (line: string) => void;
}

interface Rename {
  readonly oldName: string;
  readonly newName: string;
}

const reportPartial = (reporter: Reporter, partial: readonly PartialFailure[] = [], log: (line: string) => void = () => undefined) => {
  for (const { message, detail, severity } of partial) {
    if (severity === 'warning') reporter.report('warning', message, detail);
    else log(`${message}: ${detail}`);
  }
};

type Uninstalled = Extract<Awaited<ReturnType<ModlistCommands['uninstallMods']>>, { applied: true }>['outcome']['landed'][number];

interface ModToUninstall {
  readonly name: string;
  readonly archiveFilename?: string;
}

function partialsOfUninstall(item: Uninstalled, modOrderFile: string): PartialFailure[] {
  const partial: PartialFailure[] = [];
  if (item.sourceRefusal !== undefined) {
    partial.push({ message: `"${item.name}" was uninstalled, but its source folder could not be moved to the trash.`, detail: item.sourceRefusal, severity: 'warning' });
  }
  if (item.lineRefusal !== undefined) {
    partial.push({ message: `"${item.name}" was uninstalled, but its ${modOrderFile} line could not be removed.`, detail: item.lineRefusal, severity: 'warning' });
  } else if (item.markRefusal !== undefined) {
    partial.push({ message: `"${item.name}" was uninstalled, but its downloaded file could not be marked uninstalled`, detail: item.markRefusal, severity: 'log' });
  }
  return partial;
}

export function registerModContextCommands(
  { commands, instance, viewSelection, reporter, ask, trash, log }: ModContextDeps,
): vscode.Disposable[] {
  const rename: AgentGesture<ModlistNode, Rename, GestureResult<string>, { name: string }> = {
    fromView: async (entry) => {
      const node = singularArgument(entry, 'mod');
      if (!node) return undefined;
      const oldName = node.mod.name;
      const newName = await promptRename('Rename mod', oldName, modNamePrompt(commands, instance, oldName));
      return newName === undefined ? undefined : { oldName, newName };
    },
    fromAgent: ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to rename a mod carries one mod.');
      const oldName = modNameOf(only);
      const refusal = commands.renameModNameRefusal(instance.value, name, oldName);
      if (refusal !== undefined) throw new Refusal(refusal);
      return { oldName, newName: name };
    },
    run: ({ oldName, newName }) => runModsWriting(instance, async (): Promise<GestureResult<string>> => {
      const { activeProfile, profiles, paths, managerNames } = instance.value;
      const result = await commands.renameMod(activeProfile, profiles, oldName, newName, paths.sourceDirs.get(oldName));
      if (!result.applied) return { applied: false, refusal: 'Failed to rename mod.', detail: result.refusal };
      if (result.unchanged) return { applied: true, outcome: { landed: [], refused: [] } };
      return {
        applied: true,
        outcome: { landed: [newName], refused: [] },
        partial: result.lineRefusals.map(({ profile, refusal }) => ({
          message: `"${oldName}" was renamed, but its ${managerNames.modOrderFile} line in profile "${profile}" could not be renamed.`,
          detail: refusal, severity: 'warning',
        })),
      };
    }),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
      else reportPartial(reporter, result.partial);
    },
  };

  const uninstall: AgentGesture<ModlistNode, readonly ModToUninstall[], GestureResult<Uninstalled>> = {
    fromView: async (entry) => {
      const rows = pluralArgument(entry, 'mod');
      const mods = rows.map((n) => ({ name: n.mod.name, archiveFilename: n.mod.archiveFilename }));
      if (mods.length === 0) return undefined;
      const sourceMods = rows.filter((n) => n.facts?.tracked === true).map((n) => n.mod.name);
      return (await confirmUninstall(mods.map((m) => m.name), sourceMods, ask)) ? mods : undefined;
    },
    fromAgent: ({ argument }) => argument.map(modNameOf).map((name) => ({
      name, archiveFilename: instance.value.mods.flatMap((entry) => (entry.kind === 'mod' && entry.name === name ? [entry.archiveFilename] : []))[0],
    })),
    run: (mods) => runModsWriting(instance, async (): Promise<GestureResult<Uninstalled>> => {
      const { activeProfile, mods: order, managerNames } = instance.value;
      const result = await commands.uninstallMods(activeProfile, order, mods, trash);
      if (!result.applied) return { applied: false, refusal: 'Failed to uninstall mods.', detail: result.refusal };
      return { applied: true, outcome: result.outcome, partial: result.outcome.landed.flatMap((item) => partialsOfUninstall(item, managerNames.modOrderFile)) };
    }),
    report: (result, mods) => {
      if (!result.applied) {
        reporter.report('error', result.refusal, result.detail);
        return;
      }
      reporter.selectionOutcome(
        `Could not uninstall ${result.outcome.refused.length} of ${mods.length} mods.`, result.outcome, (m) => m.name);
      reportPartial(reporter, result.partial, log);
    },
  };

  return [
    registerAgentGesture('modbench.mod.rename', viewSelection, rename),
    registerAgentGesture('modbench.mod.uninstall', viewSelection, uninstall),
  ];
}
function separatorNamePrompt(
  commands: ModlistCommands, instance: Pick<Instance, 'value'>, own?: string,
): (value: string) => string | undefined {
  return (value) => (value === '' ? undefined : commands.separatorNameRefusal(instance.value, value, own));
}

function modNamePrompt(
  commands: ModlistCommands, instance: Pick<Instance, 'value'>, own: string,
): (value: string) => string | undefined {
  return (value) => (value === '' ? undefined : commands.renameModNameRefusal(instance.value, value, own));
}

async function confirmSeparatorDelete(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const question = names.length === 1
    ? `Delete separator "${names[0]}"? Its mods stay.`
    : `Delete separators ${names.map((n) => `"${n}"`).join(', ')}? Their mods stay.`;
  return (await ask(question, { modal: true }, 'Delete')) === 'Delete';
}

export function registerSeparatorCommands(
  commands: ModlistCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
  viewSelection: () => readonly ModlistNode[],
): vscode.Disposable[] {
  return [
      registerGesture('modbench.separator.rename', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'separator');
        if (!node) return;
        const oldName = node.separator.name;
        const newName = await promptRename('Rename separator', oldName, separatorNamePrompt(commands, instance, oldName));
        if (newName === undefined) return;
        const failed = 'Failed to rename separator.';
        await runModsWriting(instance, async () => {
          try {
            const result = await commands.renameSeparator(instance.value.activeProfile, oldName, newName);
            if (!result.applied) reporter.report('error', failed, result.refusal);
          } catch (err) {
            reporter.report('error', failed, errorMessage(err));
          }
        });
      }),
      registerGesture('modbench.separator.add', viewSelection, async (entry) => {
        const node = singularArgument(entry, 'mod', 'separator');
        if (!node) return;
        const name = await vscode.window.showInputBox({
          prompt: 'Separator name', placeHolder: 'My Group', validateInput: separatorNamePrompt(commands, instance),
        });
        if (!name) return;
        const anchor = node.kind === 'mod' ? node.mod : node.separator;
        const failed = 'Failed to add separator.';
        await runModsWriting(instance, async () => {
          try {
            const result = await commands.insertSeparator(instance.value.activeProfile, name, { kind: anchor.kind, name: anchor.name });
            if (!result.applied) reporter.report('error', failed, result.refusal);
          } catch (err) {
            reporter.report('error', failed, errorMessage(err));
          }
        });
      }),
      registerGesture('modbench.separator.delete', viewSelection, async (entry) => {
        const names = pluralArgument(entry, 'separator').map((n) => n.separator.name);
        if (names.length === 0) return;
        if (!(await confirmSeparatorDelete(names, ask))) return;
        await runModsWriting(instance, async () => {
          const result = await commands.deleteSeparators(instance.value.activeProfile, instance.value.mods, names, trash);
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
const createPartial = (name: string, lineRefusal: string | undefined, modOrderFile: string): PartialFailure[] =>
  (lineRefusal === undefined ? [] : [{ message: `"${name}" was created, but its ${modOrderFile} line could not be written.`, detail: lineRefusal, severity: 'warning' }]);

export function registerCreateEmptyModCommand(
  commands: ModlistCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
): vscode.Disposable {
  const gesture: AgentGesture<ModlistNode, string, GestureResult<string>, { name: string }> = {
    fromView: async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'New mod name', placeHolder: 'My New Mod',
        validateInput: (value) => commands.newModNameRefusal(instance.value, value),
      });
      return name || undefined;
    },
    fromAgent: ({ options: { name } }) => {
      const refusal = commands.newModNameRefusal(instance.value, name);
      if (refusal !== undefined) throw new Refusal(refusal);
      return name;
    },
    run: (name) => runModsWriting(instance, async (): Promise<GestureResult<string>> => {
      const failed = `Failed to create "${name}".`;
      try {
        const outcome = await commands.createEmptyMod(instance.value.activeProfile, name);
        return outcome.applied
          ? { applied: true, outcome: { landed: [name], refused: [] }, partial: createPartial(name, outcome.lineRefusal, instance.value.managerNames.modOrderFile) }
          : { applied: false, refusal: failed, detail: outcome.refusal };
      } catch (err) {
        return { applied: false, refusal: failed, detail: errorMessage(err) };
      }
    }),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
      else reportPartial(reporter, result.partial);
    },
  };
  return registerAgentGesture('modbench.mod.createEmpty', () => [], gesture);
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

export function registerOpenSourceCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable {
  return registerGesture('modbench.mod.openSource', viewSelection, async (entry) => {
    const node = singularArgument(entry, 'mod');
    if (node === undefined) return;
    await reportFailure(reporter, `Failed to open the source of "${node.mod.name}".`, async () => {
      const folder = instance.value.paths.sourceDirs.get(node.mod.name);
      if (folder === undefined) throw new Error('It is not a source mod.');
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
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
    case 'runtimeOutput': return { name: OVERWRITE_LABEL, folder: uriOf(overwriteDir) };
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

function copyValueOf(row: RowOf<ModlistNode, typeof COPY_KINDS[number]>): string {
  switch (row.kind) {
    case 'mod': return row.mod.name;
    case 'separator': return row.separator.name;
    case 'folder': return row.folder.relativePath;
    case 'file': return row.file.relativePath;
  }
}

/** Mods' own text for the catalog's one copy value id. `undefined` unless `clicked` is a row copy
 *  value takes or the Mods key's args, so the palette and another view's key defer. */
export const modsCopyValueText = (viewSelection: () => readonly ModlistNode[]) =>
  viewCopyValueText<ModlistNode, typeof COPY_KINDS[number]>(MODS_KEY_ARGS.view, COPY_KINDS, copyValueOf, viewSelection);
