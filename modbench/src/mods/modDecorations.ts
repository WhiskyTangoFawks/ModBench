import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import { InactiveFileDecorationProvider } from './inactiveFiles';
import { ModIndicatorDecorations } from './modIndicators';
import type { ModlistNode } from './ModListProvider';
import type { WorkspaceSettings } from './workspaceSettings';

/** Registers the file decorations a mod's files carry: the grey of an inactive file and each
 *  indicator. The caller owns the disposables. */
export function registerModDecorations(
  instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings,
  view: Pick<vscode.TreeView<ModlistNode>, 'onDidExpandElement' | 'onDidCollapseElement'>,
): vscode.Disposable[] {
  const inactive = new InactiveFileDecorationProvider(instance, settings);
  const indicators = new ModIndicatorDecorations(instance, settings);
  return [
    view.onDidExpandElement(({ element }) => { if (element.resourceUri) indicators.expandedRow(element.resourceUri); }),
    view.onDidCollapseElement(({ element }) => { if (element.resourceUri) indicators.collapsedRow(element.resourceUri); }),
    inactive, vscode.window.registerFileDecorationProvider(inactive),
    indicators, ...indicators.providers.map((provider) => vscode.window.registerFileDecorationProvider(provider)),
  ];
}
