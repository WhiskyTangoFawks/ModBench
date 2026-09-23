import * as vscode from 'vscode';
import * as path from 'node:path';
import { ModListProvider, ModNode, OverwriteNode, OVERWRITE_NODE_KIND, SeparatorNode } from './ModListProvider';
import { OverwriteDecorationProvider } from './OverwriteDecorationProvider';
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


/** Always empty, so VS Code renders the `viewsWelcome` contribution instead of the tree.
 *  `getTreeItem` is unreachable: `getChildren` never yields an element. */
export const NOT_MO2_INSTANCE_PROVIDER: vscode.TreeDataProvider<never> = {
  getTreeItem: () => { throw new Error('unreachable — NOT_MO2_INSTANCE_PROVIDER never yields children'); },
  getChildren: () => [],
};

/** The Mods tree's own view direction: a view setting, writing no MO2 file, so it lives with
 *  the view it flips and needs nothing but the provider. */
export function registerModListCoreCommands(modListProvider: ModListProvider): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.view.winningAtTop', () => {
        modListProvider.toggleViewDirection();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.winningAtTop', true);
      }),
      vscode.commands.registerCommand('modbench.modList.view.losingAtTop', () => {
        modListProvider.toggleViewDirection();
        void vscode.commands.executeCommand('setContext', 'modbench.modList.winningAtTop', false);
      }),
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
      vscode.commands.registerCommand('modbench.modList.mod.openInExplorer', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        // The value's own folder for this row, never a path joined here: the Instance adapter
        // owns every path function, and the value carries its answer.
        const folder = instance.value.paths.modDirs.get(node.mod.name);
        if (folder === undefined) return;
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
      }),
      vscode.commands.registerCommand('modbench.modList.mod.addSeparatorBelow', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('addSeparatorBelow', 'Failed to add separator.', async () => {
          const profile = instance.value.activeProfile;
          applyOrThrow(await insertSeparator(instanceRoot, profile, name, node.mod.name));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.mod.moveToSeparator', async (node: ModNode | undefined) => {
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
      vscode.commands.registerCommand('modbench.modList.mod.uninstall', async (node: ModNode | undefined) => {
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
      vscode.commands.registerCommand('modbench.modList.mod.viewOnNexus', async (node: ModNode | undefined) => {
        if (node?.kind !== 'mod' || !node.mod.nexusId) return;
        const nexusId = node.mod.nexusId;
        await runModAction('viewOnNexus', 'Failed to open Nexus page.', async () => {
          await vscode.env.openExternal(
            vscode.Uri.parse(`https://www.nexusmods.com/${instance.value.nexusSlug}/mods/${nexusId}`),
          );
        });
      }),
  ];
}
export function registerSeparatorCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>,
  runModAction: (label: string, failMessage: string, action: () => Promise<void>) => Promise<void>,
): vscode.Disposable[] {
  return [
      vscode.commands.registerCommand('modbench.modList.separator.rename', async (node: SeparatorNode | undefined) => {
        if (node?.kind !== 'separator') return;
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
      vscode.commands.registerCommand('modbench.modList.separator.addSeparatorBelow', async (node: SeparatorNode | undefined) => {
        if (node?.kind !== 'separator') return;
        const name = await vscode.window.showInputBox({ prompt: 'Separator name', placeHolder: 'My Group' });
        if (!name) return;
        await runModAction('separator.addSeparatorBelow', 'Failed to add separator.', async () => {
          const profile = instance.value.activeProfile;
          applyOrThrow(await insertSeparator(instanceRoot, profile, name, node.separator.name));
        });
      }),
      vscode.commands.registerCommand('modbench.modList.separator.delete', async (node: SeparatorNode | undefined) => {
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
  return vscode.commands.registerCommand('modbench.modList.newEmptyMod', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'New mod name', placeHolder: 'My New Mod' });
    if (!name) return;
    await runModAction('newEmptyMod', `Failed to create "${name}".`, async () => {
      const profile = instance.value.activeProfile;
      applyOrThrow(await createEmptyMod(instanceRoot, profile, name, instance.value.modFolders));
    });
  });
}
/** The pinned Overwrite row's reddish tint and its sole action; the row's own visibility and
 *  count come from the Instance's value (ADR-0015), which already recomputes on `overwrite/`. */
export function registerOverwriteView(
  instance: Pick<Instance, 'value'>,
  reporter: Reporter,
): vscode.Disposable[] {
  return [
    // Tint the pinned Overwrite row reddish. Stateless: keyed on the value's own overwrite path,
    // which is what OverwriteNode.resourceUri carries.
    vscode.window.registerFileDecorationProvider(
      new OverwriteDecorationProvider(instance.value.paths.overwriteDir)),
    vscode.commands.registerCommand('modbench.modList.overwrite.reveal', async (node: OverwriteNode | undefined) => {
      if (node?.kind !== OVERWRITE_NODE_KIND) return;
      try {
        await vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
      } catch (err) {
        reporter.report(
          'error', 'Failed to reveal the overwrite folder in the Explorer.', errorMessage(err));
      }
    }),
  ];
}
