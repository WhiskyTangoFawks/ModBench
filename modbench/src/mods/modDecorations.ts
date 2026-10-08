import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import { InactiveFileDecorationProvider } from './inactiveFiles';
import { ModIndicatorDecorations } from './modIndicators';
import { SeparatorNode, type ModlistNode } from './ModListProvider';
import type { WorkspaceSettings } from './workspaceSettings';

/** Registers the file decorations a mod's files carry: the grey of an inactive file and each
 *  indicator. The caller owns the disposables. */
export function registerModDecorations(
  instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings,
  view: Pick<vscode.TreeView<ModlistNode>, 'onDidExpandElement' | 'onDidCollapseElement'>,
): vscode.Disposable[] {
  const inactive = new InactiveFileDecorationProvider(instance, settings);
  const indicators = new ModIndicatorDecorations(instance, settings);
  const separatorUri = ({ element }: { element: ModlistNode }) => (element instanceof SeparatorNode ? element.resourceUri : undefined);
  return [
    view.onDidExpandElement((event) => { const uri = separatorUri(event); if (uri) indicators.expandedRow(uri); }),
    view.onDidCollapseElement((event) => { const uri = separatorUri(event); if (uri) indicators.collapsedRow(uri); }),
    inactive, vscode.window.registerFileDecorationProvider(inactive),
    indicators, ...indicators.providers.map((provider) => vscode.window.registerFileDecorationProvider(provider)),
  ];
}
