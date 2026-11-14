import * as vscode from 'vscode';
import { isUri, modArgumentOf, pluginArgumentOf } from '../drivingLib/argument';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { samePath } from '../symbolNames/symbolNames';
import type { PluginAddress } from '../wire/pluginAddress';
import type { ModRows, PluginRows } from '../drivingLib/symbolRows';
import { showDefinition } from './definitionShown';
import type { Asked, SymbolKinds } from './symbolKind';
import { asked } from './symbolKind';

interface WithReporter {
  reporter: Pick<Reporter, 'report'>;
}

interface GoToDeps extends WithReporter {
  kinds: SymbolKinds;
  reveal: (copy: CopyAt) => Promise<void>;
}

async function goTo({ reporter, reveal }: GoToDeps, name: string, symbol: Asked): Promise<void> {
  const definition = await symbol.definition();
  if ('refused' in definition || 'none' in definition) {
    reporter.report('error', `Could not go to ${name}: ${'refused' in definition ? definition.refused : definition.none}`);
    return;
  }
  const location = await showDefinition(definition, reveal);
  if (location !== undefined) await vscode.commands.executeCommand('vscode.open', location.uri, { selection: location.range });
}

/** `go to` on a mod: Go to Definition and the palette are its entry points (commands.md). */
export function registerGoToMod({ rows, ...deps }: GoToDeps & { rows: Pick<ModRows, 'selected'> }): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.goTo', async (clicked?: unknown) => {
    const mod = modArgumentOf(clicked ?? rows.selected())?.name;
    if (mod !== undefined) await goTo(deps, `"${mod}"`, asked(deps.kinds, { kind: 'mod', name: mod }));
  });
}

/** `go to` on a plugin: Go to Definition, Go to Symbol and the palette are its entry points (commands.md). */
export function registerGoToPlugin({ rows, ...deps }: GoToDeps & { rows: Pick<PluginRows, 'selected'> }): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.goTo', async (clicked?: unknown) => {
    const plugin = pluginArgumentOf(clicked ?? rows.selected())?.plugin;
    if (plugin !== undefined) await goTo(deps, `"${plugin.name}" (${plugin.origin})`, asked(deps.kinds, { kind: 'plugin', ...plugin }));
  });
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
