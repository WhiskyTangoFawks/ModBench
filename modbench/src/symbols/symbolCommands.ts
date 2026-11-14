import * as vscode from 'vscode';
import { isUri, modArgumentOf, pluginArgumentOf } from '../drivingLib/argument';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { samePath } from '../symbolNames/symbolNames';
import type { PluginAddress } from '../wire/pluginAddress';
import type { ModRows, PluginRows } from '../drivingLib/symbolRows';

interface WithReporter {
  reporter: Pick<Reporter, 'report'>;
}

export type FilesHeld = Pick<InstanceValue, 'filesByMod' | 'dataFolderFiles'>;

interface ReferencedBy {
  mod: (mod: string) => Promise<void>;
  file: (path: string) => Promise<void>;
}

function dataPathHolding({ filesByMod, dataFolderFiles }: FilesHeld, file: string): string | undefined {
  const inData = dataFolderFiles.kind === 'listed' ? [...dataFolderFiles.files.values()] : [];
  return [...[...filesByMod.values()].flat(), ...inData].find(({ path }) => samePath(path, file))?.relativePath;
}

/** `referenced by` on a mod row, a file row, or a file in the Explorer (mods.md, Menus and keys). */
export function registerModReferencedBy(
  { referencedBy, rows, value, reporter }: WithReporter & { referencedBy: ReferencedBy; rows: ModRows; value: () => FilesHeld },
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.referencedBy', async (clicked?: unknown) => {
    const file = rows.dataPathOf(clicked);
    if (file !== undefined) return referencedBy.file(file);
    if (isUri(clicked)) {
      const path = dataPathHolding(value(), clicked.fsPath);
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
