import * as vscode from 'vscode';
import * as path from 'node:path';
import { ModListProvider, ModNode, OverwriteNode, OVERWRITE_NODE_KIND, SeparatorNode, type ModlistNode, type SortDirection } from './ModListProvider';
import { registerModsGesture, singularArgument } from './gestureEntry';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import {
  createEmptyMod,
  deleteSeparator,
  insertSeparator,
  moveModToSeparator,
  renameSeparator,
  uninstallMod,
} from '../modlist/modlist';
import { defaultModName, installFromArchive, installFromFolder, type InstallChoice, type InstallTarget } from '../install/install';
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
export interface InstallFromArchiveOutcome {
  installed: boolean;
}

export interface ModInstallDeps {
  instanceRoot: string;
  instance: Pick<Instance, 'value'>;
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>;
  promptModName: (defaultName: string, validate?: (value: string) => string | undefined) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
}
export function registerModInstallCommands(deps: ModInstallDeps): vscode.Disposable[] {
  const { instanceRoot, instance, runModAction, promptModName, warnIfFomod } = deps;
  const validateName = (name: string) => collidingModName(instance, name);
  // An upgrade arrives already confirmed from the Downloads pick, so only a new mod reaches
  // the name prompt.
  const resolveTarget = async (choice: InstallChoice, defaultName: string): Promise<InstallTarget | undefined> => {
    if (choice.kind === 'upgrade') return choice;
    const name = await promptModName(defaultName, validateName);
    return name ? { kind: 'new', name } : undefined;
  };
  return [
      vscode.commands.registerCommand('modbench.modList.installFromArchive', async (
        archivePath?: string, modID?: string, fileID?: string, version?: string,
        choice: InstallChoice = { kind: 'new' },
      ): Promise<InstallFromArchiveOutcome> => {
        let archive = archivePath;
        if (!archive) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Mod archives': ['zip', '7z', 'rar'] },
            openLabel: 'Install',
          });
          archive = picked?.[0]?.fsPath;
        }
        if (!archive) return { installed: false };
        const resolvedArchive = archive;
        const target = await resolveTarget(choice, defaultModName(resolvedArchive));
        if (!target) return { installed: false };
        let succeeded = false;
        await runModAction('installFromArchive', `Failed to install "${target.name}".`, async () => {
          const outcome = await installFromArchive(
            instanceRoot, target, resolvedArchive,
            { gameName: instance.value.gameRelease, modID, fileID, version });
          if (!outcome.applied) throw new Error(outcome.refusal);
          warnIfFomod(target.name, outcome.isFomod);
          succeeded = true;
        });
        return { installed: succeeded };
      }),
      vscode.commands.registerCommand('modbench.modList.installFromFolder', async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Install',
        });
        const folder = picked?.[0]?.fsPath;
        if (!folder) return;
        const target = await resolveTarget({ kind: 'new' }, path.basename(folder));
        if (!target) return;
        await runModAction('installFromFolder', `Failed to install "${target.name}".`, async () => {
          const outcome = await installFromFolder(instanceRoot, target, folder, { gameName: instance.value.gameRelease });
          if (!outcome.applied) throw new Error(outcome.refusal);
          warnIfFomod(target.name, outcome.isFomod);
        });
      }),
  ];
}
export function registerModContextCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
  ask: AskQuestion,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.mod.move', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        const separators = instance.value.mods.filter((e) => e.kind === 'separator').map((e) => e.name);
        const items: Array<vscode.QuickPickItem & { sepName: string | null }> = [
          { label: 'Ungrouped', description: 'Before first separator', sepName: null },
          ...separators.map((s) => ({ label: s, sepName: s })),
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Move to separator…' });
        if (!picked) return;
        await runModAction('moveToSeparator', 'Failed to move mod.', async () => {
          const profile = instance.value.activeProfile;
          applyOrThrow(await moveModToSeparator(instanceRoot, profile, node.mod.name, picked.sepName));
        });
      }),
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
      // One command for both anchors: modlist commands' insertSeparator resolves the anchor's
      // kind and picks the position (mods.md, Add separator).
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
/** Mods tree title-bar action: a name prompt, refusing a name already in use (ADR-0015 invariant 2
 *  — the command itself decides the refusal; this only surfaces it). */
export function registerCreateEmptyModCommand(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.createEmpty', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'New mod name', placeHolder: 'My New Mod' });
    if (!name) return;
    await runModAction('newEmptyMod', `Failed to create "${name}".`, async () => {
      const profile = instance.value.activeProfile;
      applyOrThrow(await createEmptyMod(instanceRoot, profile, name, instance.value.modFolders ?? []));
    });
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
