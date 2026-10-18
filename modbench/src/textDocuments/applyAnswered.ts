import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { SourceEditing } from './sourceEditing';
import type { WorkspaceChanges } from './applyWorkspaceChanges';

export type ApplyingSource = Pick<SourceEditing, 'applyWorkspaceChanges' | 'refreshSourceControlFor'>;

/** Applies the changes mEdit answered, resolving why VS Code could not apply them, or undefined when it did.
 *  VS Code keeps what it applied before a change it cannot make, so Source Control refreshes for every plugin
 *  touched. */
export async function applyUnreported(
  source: ApplyingSource, items: readonly WorkspaceChanges[], plugins: readonly PluginAddress[],
): Promise<string | undefined> {
  let failure: string | undefined;
  try {
    if (items.length > 0) await source.applyWorkspaceChanges(items);
  } catch (error) {
    failure = `${errorMessage(error)} VS Code stops at the first change it cannot make, so some changes may have landed.`;
  }
  for (const plugin of new Map(plugins.map((p) => [pluginAddressKey(p), p])).values()) source.refreshSourceControlFor(plugin);
  return failure;
}

export async function applyAnswered(
  source: ApplyingSource, reporter: Reporter, items: readonly WorkspaceChanges[], plugins: readonly PluginAddress[],
  notApplied: string,
): Promise<boolean> {
  const failure = await applyUnreported(source, items, plugins);
  if (failure !== undefined) reporter.report('error', notApplied, failure);
  return failure === undefined;
}
