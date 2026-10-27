import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import { InactiveFileDecorationProvider } from './inactiveFiles';
import { ModIndicatorDecorations } from './modIndicators';
import type { OpenRows } from './openRows';
import { PublisherTagDecorations } from './publisherTagIndicators';
import type { WorkspaceSettings } from './workspaceSettings';

/** Registers the file decorations the Mods view's rows carry: the grey of an inactive file, each
 *  indicator and each publisher tag. The caller owns the disposables. */
export function registerModDecorations(
  instance: Pick<InstanceView, 'value' | 'subscribe'>, open: OpenRows, settings: WorkspaceSettings,
): vscode.Disposable[] {
  const inactive = new InactiveFileDecorationProvider(instance, settings);
  const indicators = new ModIndicatorDecorations(instance, open, settings);
  const publisherTags = new PublisherTagDecorations(instance, open, settings);
  const opening = [indicators, publisherTags];
  return [
    inactive, vscode.window.registerFileDecorationProvider(inactive),
    ...opening.flatMap((rows) => [rows, ...rows.providers.map((provider) => vscode.window.registerFileDecorationProvider(provider))]),
  ];
}
