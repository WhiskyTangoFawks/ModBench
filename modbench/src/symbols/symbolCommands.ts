import * as vscode from 'vscode';
import { isUri, modArgumentOf, pluginArgumentOf } from '../drivingLib/argument';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { samePath } from '../symbolNames/symbolNames';
import type { PluginAddress } from '../wire/pluginAddress';
import type { ModRows, PluginRows, Reveal } from '../drivingLib/symbolRows';
import { goToRowOrFile } from './goToRow';

const reveal = (show: Reveal): PromiseLike<void> => show();

interface Reading {
  reporter: Pick<Reporter, 'report'>;
}

/** `go to` on a mod: Go to Definition and the palette are its entry points (commands.md). */
export function registerGoToMod({ rows, reporter }: Reading & { rows: ModRows }): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.goTo', async (clicked?: unknown) => {
    const mod = modArgumentOf(clicked ?? rows.selected())?.name;
    if (mod === undefined) return;
    await goToRowOrFile({
      name: `"${mod}"`, row: rows.show(mod), file: rows.folderOf(mod), reveal, reporter, nowhere: 'Mods shows no row for it and no folder holds it.',
    });
  });
}

/** `go to` on a plugin: Go to Definition, Go to Symbol and the palette are its entry points (commands.md). */
export function registerGoToPlugin({ rows, reporter }: Reading & { rows: PluginRows }): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.goTo', async (clicked?: unknown) => {
    const plugin = pluginArgumentOf(clicked ?? rows.selected())?.plugin;
    if (plugin === undefined) return;
    await goToRowOrFile({
      name: `"${plugin.name}" (${plugin.origin})`, row: rows.show(plugin), file: rows.fileOf(plugin), reveal, reporter,
      nowhere: 'Plugins shows no row for it and no file holds it.',
    });
  });
}

type FilesHeld = Pick<InstanceValue, 'filesByMod' | 'dataFolderFiles'>;

/** Lists, in VS Code's References view, each place a file names the mod, or each record that names the file at its path in
 *  the Data folder. */
export interface ReferencedBy {
  mod: (mod: string) => Promise<void>;
  file: (path: string) => Promise<void>;
}

function dataPathOf({ filesByMod, dataFolderFiles }: FilesHeld, file: string): string | undefined {
  const inData = dataFolderFiles.kind === 'listed' ? [...dataFolderFiles.files.values()] : [];
  return [...[...filesByMod.values()].flat(), ...inData].find(({ path }) => samePath(path, file))?.relativePath;
}

/** `referenced by` on a mod row, a file row, or a file in the Explorer (mods.md, Menus and keys). */
export function registerModReferencedBy(
  { referencedBy, rows, value, reporter }: Reading & { referencedBy: ReferencedBy; rows: ModRows; value: () => FilesHeld },
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.referencedBy', async (clicked?: unknown) => {
    const file = rows.fileOf(clicked);
    if (file !== undefined) return referencedBy.file(file);
    if (isUri(clicked)) {
      const path = dataPathOf(value(), clicked.fsPath);
      if (path !== undefined) return referencedBy.file(path);
      reporter.report('error', `Could not list where files name ${clicked.fsPath}.`, 'No mod holds it, and it is not in the game\'s Data folder.');
      return;
    }
    const mod = modArgumentOf(clicked ?? rows.selected())?.name;
    if (mod !== undefined) await referencedBy.mod(mod);
  });
}

/** `referenced by` on a plugin row: lists where files name it (plugins.md, Menus and keys). */
export function registerPluginReferencedBy(
  { referencedBy, rows }: { referencedBy: (plugin: PluginAddress) => Promise<void>; rows: PluginRows },
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.referencedBy', async (clicked?: unknown) => {
    const plugin = pluginArgumentOf(clicked ?? rows.selected())?.plugin;
    if (plugin) await referencedBy(plugin);
  });
}
