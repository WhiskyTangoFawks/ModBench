import * as vscode from 'vscode';
import type { InstanceValue, InstanceView } from '../instanceLoader/instance';
import { modOrigin, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { fileRowUri } from './modFiles';
import { modRowUri, overwriteRowUri, separatorRowUri } from './modIndicators';

function openableRows(value: InstanceValue): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const entry of value.mods) {
    if (entry.kind !== 'mod') continue;
    keys.add(modRowUri(entry.name).toString());
    for (const { relativePath } of value.foldersByMod.get(entry.name) ?? []) keys.add(fileRowUri(modOrigin(entry.name), relativePath).toString());
  }
  keys.add(overwriteRowUri().toString());
  for (const { relativePath } of value.overwriteFolders) keys.add(fileRowUri(RUNTIME_OUTPUT, relativePath).toString());
  for (const { separator, mods } of value.modGroups.groups) {
    if (mods.length > 0) keys.add(separatorRowUri(separator.name).toString());
  }
  return keys;
}

/** The rows the Mods view shows open, kept to those the instance still lists, so a row made again under a removed row's name starts
 *  collapsed. Created before its readers, it prunes ahead of them. */
export class OpenRows implements vscode.Disposable {
  private readonly expanded = new Set<string>();
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(instance: Pick<InstanceView, 'subscribe'>) {
    this.subscription = instance.subscribe((value) => {
      const openable = openableRows(value);
      for (const key of this.expanded) if (!openable.has(key)) this.expanded.delete(key);
    });
  }

  has(key: string): boolean {
    return this.expanded.has(key);
  }

  expandedRow(uri: vscode.Uri): void {
    this.expanded.add(uri.toString());
    this.changed.fire(undefined);
  }

  collapsedRow(uri: vscode.Uri): void {
    this.expanded.delete(uri.toString());
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
