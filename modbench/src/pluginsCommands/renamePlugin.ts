// Rename plugin (rename-plugin trace). The client's reach is the plugin source's changes, which only mEdit
// can answer, and the dependants query; the file and its lines are the Instance adapter's.

import { OVERWRITE_ORIGIN, type FileOrigin, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { isRefused, type MEditClient, type SourceChanges } from '../client';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';
import type { PluginAddress } from '../wire/pluginAddress';
import { answerOf } from '../wire/readFailed';

interface RenameSourceEditing {
  /** Resolves whether the changes were applied; a failure has been reported by whoever applied them. */
  readonly apply: (changes: SourceChanges) => Promise<boolean>;
}

export interface PluginRenameAccess {
  readonly adapter: InstanceAdapter;
  readonly client: Pick<MEditClient, 'getRenameSourceChanges' | 'moveLastWritten'>;
  readonly source: RenameSourceEditing;
}

export interface PluginRenameConfirmation {
  readonly adapter: InstanceAdapter;
  readonly client: Pick<MEditClient, 'getPluginDependants'>;
  readonly ask: AskQuestion;
}

/** `refusal` is absent when the user declined the question. */
export type RenameConfirmed = { confirmed: true } | { confirmed: false; refusal?: string };

/** `sourceRenamed` is true when the files and lines failed after the source had moved. `reported` is a failure to
 *  apply the source changes, which the apply has already told. */
export type PluginRenameResult =
  | { applied: true }
  | { applied: false; reported: true }
  | { applied: false; sourceRenamed: boolean; refusal: string };

const CONFIRM = 'Rename';

const fileOriginOf = (origin: string): FileOrigin =>
  origin === OVERWRITE_ORIGIN ? { kind: 'runtimeOutput' } : { kind: 'mod', name: origin };

const named = ({ name, origin }: PluginAddress): string => `${name} (${origin})`;

function listing(heading: string, plugins: readonly PluginAddress[]): string[] {
  return plugins.length === 0 ? [] : [heading, ...plugins.map(named)];
}

/** What can be known before any write: the adapter's refusals, then one question when plugins list
 *  the plugin as a master or may. Writes nothing. */
export async function confirmRename(
  access: PluginRenameConfirmation, plugin: PluginAddress, newName: string, gameRelease: string | undefined,
): Promise<RenameConfirmed> {
  const checked = await access.adapter.checkPluginRename(fileOriginOf(plugin.origin), plugin.name, newName, gameRelease);
  if (!checked.applied) return { confirmed: false, refusal: checked.refusal };

  let dependants;
  try {
    dependants = answerOf(await access.client.getPluginDependants(plugin));
  } catch (err) {
    return { confirmed: false, refusal: errorMessage(err) };
  }
  if (dependants.dependants.length + dependants.unreadable.length === 0) return { confirmed: true };

  const detail = [
    ...listing('Keep the old name and will show Master issues:', dependants.dependants),
    ...listing('mEdit could not read their masters, so they may keep the old name:', dependants.unreadable),
  ].join('\n');
  const answer = await access.ask(`Rename "${plugin.name}" to "${newName}"?`, { modal: true, detail }, CONFIRM);
  return answer === CONFIRM ? { confirmed: true } : { confirmed: false };
}

export async function renamePlugin(
  access: PluginRenameAccess, plugin: PluginAddress, newName: string, gameRelease: string | undefined,
): Promise<PluginRenameResult> {
  const origin = fileOriginOf(plugin.origin);
  const checked = await access.adapter.checkPluginRename(origin, plugin.name, newName, gameRelease);
  if (!checked.applied) return { applied: false, sourceRenamed: false, refusal: checked.refusal };

  const changes = await access.client.getRenameSourceChanges(plugin, newName);
  if (isRefused(changes)) return { applied: false, sourceRenamed: false, refusal: changes.message };
  if (!await access.source.apply(changes)) return { applied: false, reported: true };

  const moved = await access.client.moveLastWritten(plugin, changes.treeName, newName);
  if (isRefused(moved)) return { applied: false, sourceRenamed: true, refusal: moved.message };
  try {
    await access.adapter.renamePlugin(origin, plugin.name, newName, gameRelease);
    return { applied: true };
  } catch (err) {
    return { applied: false, sourceRenamed: true, refusal: errorMessage(err) };
  }
}
