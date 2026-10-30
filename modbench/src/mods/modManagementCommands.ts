import * as vscode from 'vscode';
import { OVERWRITE_LABEL } from '../instanceLoader/fileConflictIndex';
import type { ModlistNode } from './ModListProvider';
import type { SortDirection } from '../drivingLib/sortDirectionToggle';
import type { NexusModRow } from '../drivingLib/inFocusedView';
import { promptRename } from '../drivingLib/promptRename';
import { MODS_KEY_ARGS, entryRefOf, fileRefOf, modNameOf, separatorNameOf, runModsWriting, openFolderArgument } from './gestureEntry';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { viewCopyValueText } from '../drivingLib/copyValue';
import {
  pluralArgument, registerGesture, singularArgument, type RowOf,
} from '../drivingLib/gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import type { EntryRef, ModCommands, MovePlace, OriginFileMark, OriginFileRef, SelectionResult } from '../modCommands/modCommands';
import { FILE_MARKS, fileLabel } from './modFiles';
import {
  endAtTop, onlyCurrent, modsMovePick, moveTargetOf, separatorsMovePick, type MovePickItem, type MoveTarget,
} from './movePick';
import { errorMessage } from '../ports/errorMessage';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { reportFailure } from '../drivingLib/reportFailure';
import { Refusal } from '../drivingLib/refusal';
import { promptRefusal, refuseAgentName } from './nameRefusals';

// modbench.mod.enable / modbench.mod.disable: the whole selection through the entry (mods.md,
// Menus and keys, story 2). Each mod lands on its own (commands.md, "A selection is one gesture").
export function registerModEnableCommands(
  commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>,
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
      run: (modNames) => runModsWriting(instance, () => commands.setModsEnabled(modNames, enabled)),
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
  commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, viewSelection: () => readonly ModlistNode[], reporter: Reporter,
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
        const result = await runModsWriting(instance, () => commands.markFiles(refs, mark));
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

interface Move {
  readonly kind: 'mod' | 'separator';
  readonly names: readonly string[];
  readonly target: MoveTarget;
}

export function registerModMoveCommand(
  commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, view: MoveView, reporter: Reporter,
): vscode.Disposable {
  const asMoveResult = (kind: Move['kind'], result: SelectionResult<string>): GestureResult<string> =>
    result.applied ? result : { applied: false, refusal: `Failed to move ${kind}s.`, detail: result.refusal };

  const gesture: AgentGesture<ModlistNode, Move, GestureResult<string>, MoveTarget> = {
    fromView: async (entry, option) => {
      const rows = pluralArgument(entry, 'mod', 'separator');
      const modNames = rows.flatMap((row) => (row.kind === 'mod' ? [row.mod.name] : []));
      const separatorNames = rows.flatMap((row) => (row.kind === 'separator' ? [row.separator.name] : []));
      const { modGroups } = instance.value;
      const direction = view.direction();
      const given = moveTargetOf(option);
      const pick = async <T extends MovePlace>(items: MovePickItem<T>[], placeholder: string) => {
        const picked = await pickWithMarked(items, onlyCurrent(items), placeholder);
        return picked && { place: picked.target, end: endAtTop(direction) };
      };
      if (modNames.length > 0 && separatorNames.length === 0) {
        const target = given ?? await pick(modsMovePick(modGroups, direction, modNames), 'Move to…');
        return target && { kind: 'mod', names: modNames, target };
      }
      if (separatorNames.length > 0 && modNames.length === 0) {
        const target = given ?? await pick(separatorsMovePick(modGroups, direction, separatorNames), 'Move above…');
        return target && { kind: 'separator', names: separatorNames, target };
      }
      return undefined;
    },
    fromAgent: ({ argument, options }) => {
      const entries = argument.map(entryRefOf);
      const kind = entries[0]?.kind ?? 'mod';
      if (entries.some((entry) => entry.kind !== kind)) throw new Refusal('An agent call to move carries mods or separators, not both.');
      return { kind, names: entries.map((entry) => entry.name), target: options };
    },
    run: ({ kind, names, target: { place, end } }) =>
      runModsWriting(instance, async () => asMoveResult(
        kind, await (kind === 'mod' ? commands.moveMods(names, place, end) : commands.moveSeparators(names, place, end)))),
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
  commands: ModCommands;
  instance: Pick<Instance, 'value' | 'refresh' | 'quiet'>;
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

type Uninstalled = Extract<Awaited<ReturnType<ModCommands['uninstallMods']>>, { applied: true }>['outcome']['landed'][number];

function partialsOfUninstall(item: Uninstalled, modOrderFile: string): PartialFailure[] {
  const partial: PartialFailure[] = [];
  if (item.sourceRefusal !== undefined) {
    partial.push({ message: `"${item.name}" was uninstalled, but its source folder could not be moved to the trash.`, detail: item.sourceRefusal, severity: 'warning' });
  }
  if (item.tagRefusal !== undefined) {
    partial.push({ message: `"${item.name}" was uninstalled, but its publisher tags could not be removed.`, detail: item.tagRefusal, severity: 'warning' });
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
      const newName = await promptRename('Rename mod', oldName, modNamePrompt(commands, oldName));
      return newName === undefined ? undefined : { oldName, newName };
    },
    fromAgent: ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to rename a mod carries one mod.');
      const oldName = modNameOf(only);
      return { oldName, newName: name };
    },
    run: ({ oldName, newName }) => runModsWriting(instance, async (): Promise<GestureResult<string>> => {
      const result = await instance.quiet(() => commands.renameMod(oldName, newName));
      if (!result.applied) return { applied: false, refusal: 'Failed to rename mod.', detail: result.refusal };
      if (result.unchanged) return { applied: true, outcome: { landed: [], refused: [] } };
      return {
        applied: true,
        outcome: { landed: [newName], refused: [] },
        partial: [
          ...(result.tagRefusal === undefined ? [] : [{ message: `"${oldName}" was renamed, but its publisher tags could not follow it.`, detail: result.tagRefusal, severity: 'warning' as const }]),
          ...(result.keepOutRefusal === undefined ? [] : [{ message: `"${oldName}" was renamed, but the files Modbench keeps could not be kept out of the publisher.`, detail: result.keepOutRefusal, severity: 'warning' as const }]),
          ...result.lineRefusals.map(({ profile, refusal }) => ({
            message: `"${oldName}" was renamed, but its ${commands.names.modOrderFile} line in profile "${profile}" could not be renamed.`,
            detail: refusal, severity: 'warning' as const,
          })),
        ],
      };
    }),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
      else reportPartial(reporter, result.partial);
    },
  };

  const uninstall: AgentGesture<ModlistNode, readonly string[], GestureResult<Uninstalled>> = {
    fromView: async (entry) => {
      const rows = pluralArgument(entry, 'mod');
      const mods = rows.map((n) => n.mod.name);
      if (mods.length === 0) return undefined;
      const sourceMods = rows.filter((n) => n.facts?.sourceMod === true).map((n) => n.mod.name);
      return (await confirmUninstall(mods, sourceMods, ask)) ? mods : undefined;
    },
    fromAgent: ({ argument }) => argument.map(modNameOf),
    run: (mods) => runModsWriting(instance, async (): Promise<GestureResult<Uninstalled>> => {
      const result = await commands.uninstallMods(mods, trash);
      if (!result.applied) return { applied: false, refusal: 'Failed to uninstall mods.', detail: result.refusal };
      return { applied: true, outcome: result.outcome, partial: result.outcome.landed.flatMap((item) => partialsOfUninstall(item, commands.names.modOrderFile)) };
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
  commands: ModCommands, own?: string,
): (value: string) => Promise<string | undefined> | undefined {
  return (value) => (value === '' ? undefined : promptRefusal(commands.separatorNameRefusal(value, own)));
}

function modNamePrompt(
  commands: ModCommands, own: string,
): (value: string) => Promise<string | undefined> | undefined {
  return (value) => (value === '' ? undefined : promptRefusal(commands.renameModNameRefusal(value, own)));
}

async function confirmSeparatorDelete(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const question = names.length === 1
    ? `Delete separator "${names[0]}"? Its mods stay.`
    : `Delete separators ${names.map((n) => `"${n}"`).join(', ')}? Their mods stay.`;
  return (await ask(question, { modal: true }, 'Delete')) === 'Delete';
}

interface SeparatorAdd {
  readonly name: string;
  readonly anchor: EntryRef;
}

interface SeparatorRename {
  readonly oldName: string;
  readonly newName: string;
}

type DeletedSeparator = Extract<Awaited<ReturnType<ModCommands['deleteSeparators']>>, { applied: true }>['outcome']['landed'][number];

function renameGesture(
  commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
): AgentGesture<ModlistNode, SeparatorRename, GestureResult<string>, { name: string }> {
  return {
    fromView: async (entry) => {
      const node = singularArgument(entry, 'separator');
      if (!node) return undefined;
      const oldName = node.separator.name;
      const newName = await promptRename('Rename separator', oldName, separatorNamePrompt(commands, oldName));
      return newName === undefined ? undefined : { oldName, newName };
    },
    fromAgent: ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to rename a separator carries one separator.');
      const oldName = separatorNameOf(only);
      return { oldName, newName: name };
    },
    run: ({ oldName, newName }) => runModsWriting(instance, async (): Promise<GestureResult<string>> => {
      const result = await commands.renameSeparator(oldName, newName);
      if (!result.applied) return { applied: false, refusal: 'Failed to rename separator.', detail: result.refusal };
      return { applied: true, outcome: { landed: result.wrote ? [result.name] : [], refused: [] } };
    }),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
    },
  };
  }

  function addGesture(
    commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
  ): AgentGesture<ModlistNode, SeparatorAdd, GestureResult<string>, { name: string }> {
    return {
    fromView: async (entry) => {
      const node = singularArgument(entry, 'mod', 'separator');
      if (!node) return undefined;
      const name = await vscode.window.showInputBox({
        prompt: 'Separator name', placeHolder: 'My Group', validateInput: separatorNamePrompt(commands),
      });
      if (!name) return undefined;
      const anchor = node.kind === 'mod' ? node.mod : node.separator;
      return { name, anchor: { kind: anchor.kind, name: anchor.name } };
    },
    fromAgent: ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to add a separator carries one mod or separator, the anchor.');
      return { name, anchor: entryRefOf(only) };
    },
    run: ({ name, anchor }) => runModsWriting(instance, async (): Promise<GestureResult<string>> => {
      const result = await commands.insertSeparator(name, anchor);
      return result.applied
        ? { applied: true, outcome: { landed: [result.name], refused: [] } }
        : { applied: false, refusal: 'Failed to add separator.', detail: result.refusal };
    }),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
    },
  };
  }

  function deleteGesture(
    commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
  ): AgentGesture<ModlistNode, readonly string[], GestureResult<DeletedSeparator>> {
    return {
    fromView: async (entry) => {
      const names = pluralArgument(entry, 'separator').map((n) => n.separator.name);
      return names.length > 0 && await confirmSeparatorDelete(names, ask) ? names : undefined;
    },
    fromAgent: ({ argument }) => argument.map(separatorNameOf),
    run: (names) => runModsWriting(instance, async (): Promise<GestureResult<DeletedSeparator>> => {
      const result = await commands.deleteSeparators(names, trash);
      if (!result.applied) return { applied: false, refusal: 'Failed to delete separators.', detail: result.refusal };
      return {
        applied: true,
        outcome: result.outcome,
        partial: result.outcome.landed.flatMap((item) => (item.lineRefusal === undefined ? [] : [{
          message: `"${item.name}" was deleted, but its ${commands.names.modOrderFile} line could not be removed.`,
          detail: item.lineRefusal, severity: 'warning' as const,
        }])),
      };
    }),
    report: (result, names) => {
      if (!result.applied) {
        reporter.report('error', result.refusal, result.detail);
        return;
      }
      reporter.selectionOutcome(
        `Could not delete ${result.outcome.refused.length} of ${names.length} separators.`, result.outcome, (item) => item.name);
      reportPartial(reporter, result.partial);
    },
  };
  }

  export function registerSeparatorCommands(
    commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
    viewSelection: () => readonly ModlistNode[],
  ): vscode.Disposable[] {
    return [
      registerAgentGesture('modbench.separator.rename', viewSelection, renameGesture(commands, instance, reporter)),
      registerAgentGesture('modbench.separator.add', viewSelection, addGesture(commands, instance, reporter)),
      registerAgentGesture('modbench.separator.delete', viewSelection, deleteGesture(commands, instance, reporter, ask, trash)),
    ];
  }
  const createPartial = (name: string, lineRefusal: string | undefined, modOrderFile: string): PartialFailure[] =>
    (lineRefusal === undefined ? [] : [{ message: `"${name}" was created, but its ${modOrderFile} line could not be written.`, detail: lineRefusal, severity: 'warning' }]);

  export function registerCreateEmptyModCommand(
    commands: ModCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
  ): vscode.Disposable {
    const gesture: AgentGesture<ModlistNode, string, GestureResult<string>, { name: string }> = {
      fromView: async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'New mod name', placeHolder: 'My New Mod',
          validateInput: (value) => promptRefusal(commands.newModNameRefusal(value)),
        });
        return name || undefined;
      },
      fromAgent: async ({ options: { name } }) => {
        await refuseAgentName(commands.newModNameRefusal(name));
        return name;
      },
      run: (name) => runModsWriting(instance, async (): Promise<GestureResult<string>> => {
        const failed = `Failed to create "${name}".`;
        try {
          const outcome = await commands.createEmptyMod(name);
          return outcome.applied
            ? { applied: true, outcome: { landed: [name], refused: [] }, partial: createPartial(name, outcome.lineRefusal, commands.names.modOrderFile) }
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
    const { nexusModId, gameName = instance.value.gameName } = (row ?? selectedRow()) ?? {};
    if (!nexusModId) return;
    await reportFailure(reporter, `Failed to open the Nexus page of mod ${nexusModId}.`, async () => {
      const domain = instance.value.nexusDomainOf(gameName);
      if (domain === undefined) throw new Error(`Nexus has no domain for the game '${gameName}'.`);
      await vscode.env.openExternal(vscode.Uri.parse(`https://www.nexusmods.com/${domain}/mods/${nexusModId}`));
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
