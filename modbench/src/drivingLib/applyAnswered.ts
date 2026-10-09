import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { SourceEditing } from './sourceEditing';
import type { WorkspaceChanges } from './applyWorkspaceChanges';

export type ApplyingSource = Pick<SourceEditing, 'applyWorkspaceChanges' | 'refreshSourceControlFor'>;

/** What an apply came to: whether VS Code applied the changes, and the files it did not save. */
export interface ApplyOutcome { applied: boolean; notSaved: readonly string[] }

/** Applies the changes mEdit answered and reports. VS Code keeps what it applied before a change it cannot
 *  make, so Source Control refreshes for every plugin touched. */
export async function applyAndReport(
  source: ApplyingSource, reporter: Reporter, items: readonly WorkspaceChanges[], plugins: readonly PluginAddress[],
  failures: { notApplied: string; notSaved: string },
): Promise<ApplyOutcome> {
  let notSaved: readonly string[] = [];
  let applied = true;
  try {
    if (items.length > 0) notSaved = await source.applyWorkspaceChanges(items);
  } catch (error) {
    applied = false;
    reporter.report(
      'error', failures.notApplied,
      `${errorMessage(error)} VS Code stops at the first change it cannot make, so some changes may have landed.`);
  }
  for (const plugin of new Map(plugins.map((p) => [pluginAddressKey(p), p])).values()) source.refreshSourceControlFor(plugin);
  if (notSaved.length > 0) reporter.report('error', failures.notSaved, `VS Code did not save ${notSaved.join(', ')}.`);
  return { applied, notSaved };
}

/** `applyAndReport`, resolving whether all were applied. */
export async function applyAnswered(
  source: ApplyingSource, reporter: Reporter, items: readonly WorkspaceChanges[], plugins: readonly PluginAddress[],
  failures: { notApplied: string; notSaved: string },
): Promise<boolean> {
  return (await applyAndReport(source, reporter, items, plugins, failures)).applied;
}
