import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { SourceEditing } from './sourceEditing';
import type { WorkspaceChanges } from './applyWorkspaceChanges';

export type ApplyingSource = Pick<SourceEditing, 'applyWorkspaceChanges' | 'refreshSourceControlFor'>;

/** Applies the changes mEdit answered and reports, resolving whether VS Code applied them. VS Code keeps what it
 *  applied before a change it cannot make, so Source Control refreshes for every plugin touched. */
export async function applyAnswered(
  source: ApplyingSource, reporter: Reporter, items: readonly WorkspaceChanges[], plugins: readonly PluginAddress[],
  notApplied: string,
): Promise<boolean> {
  let applied = true;
  try {
    if (items.length > 0) await source.applyWorkspaceChanges(items);
  } catch (error) {
    applied = false;
    reporter.report(
      'error', notApplied,
      `${errorMessage(error)} VS Code stops at the first change it cannot make, so some changes may have landed.`);
  }
  for (const plugin of new Map(plugins.map((p) => [pluginAddressKey(p), p])).values()) source.refreshSourceControlFor(plugin);
  return applied;
}
