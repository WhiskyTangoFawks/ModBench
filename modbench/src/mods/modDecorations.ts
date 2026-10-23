import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import { InactiveFileDecorationProvider } from './inactiveFiles';
import { ModIndicatorDecorations } from './modIndicators';
import type { ModlistNode } from './ModListProvider';
import { PublisherTagDecorations } from './publisherTagIndicators';
import type { WorkspaceSettings } from './workspaceSettings';

/** Registers the file decorations the Mods view's rows carry: the grey of an inactive file, each
 *  indicator and each publisher tag. The caller owns the disposables. */
export function registerModDecorations(
  instance: Pick<InstanceView, 'value' | 'subscribe'>, settings: WorkspaceSettings,
  view: Pick<vscode.TreeView<ModlistNode>, 'onDidExpandElement' | 'onDidCollapseElement'>,
): vscode.Disposable[] {
  const inactive = new InactiveFileDecorationProvider(instance, settings);
  const indicators = new ModIndicatorDecorations(instance, settings);
  const publisherTags = new PublisherTagDecorations(instance, settings);
  const opening = [indicators, publisherTags];
  return [
    view.onDidExpandElement(({ element }) => { if (element.resourceUri) for (const rows of opening) rows.expandedRow(element.resourceUri); }),
    view.onDidCollapseElement(({ element }) => { if (element.resourceUri) for (const rows of opening) rows.collapsedRow(element.resourceUri); }),
    inactive, vscode.window.registerFileDecorationProvider(inactive),
    ...opening.flatMap((rows) => [rows, ...rows.providers.map((provider) => vscode.window.registerFileDecorationProvider(provider))]),
  ];
}
