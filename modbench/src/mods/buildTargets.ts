import * as vscode from 'vscode';
import { BUILD_FILE } from '../wire/sourceMod';

export const BUILD_TARGETS_KEY = 'modbench.source.buildTargets';

/** The Explorer resources that build a source mod, each keyed by its URI string: its source folder and its build file. */
export function buildTargetsOf(sourceDirs: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  return new Map([...sourceDirs].flatMap(([mod, folder]) => {
    const uri = vscode.Uri.file(folder);
    return [[uri.toString(), mod], [vscode.Uri.joinPath(uri, BUILD_FILE).toString(), mod]] as const;
  }));
}

export const isUri = (value: unknown): value is vscode.Uri =>
  typeof value === 'object' && value !== null && 'fsPath' in value && 'scheme' in value;

/** Tells the menus which Explorer resources build a source mod. */
export function publishBuildTargets(sourceDirs: ReadonlyMap<string, string>): void {
  void vscode.commands.executeCommand('setContext', BUILD_TARGETS_KEY, [...buildTargetsOf(sourceDirs).keys()]);
}
