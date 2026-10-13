// Rename plugin (rename-plugin trace). The client's reach is the plugin source's changes, which only mEdit
// can answer, and the dependants query; the file and its lines are the Instance adapter's.

import type { TailOf } from '../coreLib/boundCommand';
import { OVERWRITE_ORIGIN, type FileOrigin, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { isRefused, type MEditClient, type SourceChanges } from '../client';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';
import type { PluginAddress } from '../wire/pluginAddress';
import { answerOf } from '../wire/readFailed';

export type PluginRenameClient = Pick<MEditClient, 'getRenameSourceChanges' | 'moveLastWritten' | 'getPluginDependants'>;

interface PluginRenameAccess {
  readonly adapter: InstanceAdapter;
  readonly client: PluginRenameClient;
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

// One question when plugins list the plugin as a master or may. Writes nothing.
async function confirmRename(access: PluginRenameAccess, ask: AskQuestion, plugin: PluginAddress, newName: string): Promise<RenameConfirmed> {
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
  const answer = await ask(`Rename "${plugin.name}" to "${newName}"?`, { modal: true, detail }, CONFIRM);
  return answer === CONFIRM ? { confirmed: true } : { confirmed: false };
}

async function renamePlugin(
  access: PluginRenameAccess, source: { apply(changes: SourceChanges): Promise<boolean> }, plugin: PluginAddress, newName: string, gameRelease: string | undefined,
): Promise<PluginRenameResult> {
  const origin = fileOriginOf(plugin.origin);
  const changes = await access.client.getRenameSourceChanges(plugin, newName);
  if (isRefused(changes)) return { applied: false, sourceRenamed: false, refusal: changes.message };
  if (!await source.apply(changes)) return { applied: false, reported: true };

  const moved = await access.client.moveLastWritten(plugin, changes.treeName, newName);
  if (isRefused(moved)) return { applied: false, sourceRenamed: true, refusal: moved.message };
  try {
    await access.adapter.renamePlugin(origin, plugin.name, newName, gameRelease);
    return { applied: true };
  } catch (err) {
    return { applied: false, sourceRenamed: true, refusal: errorMessage(err) };
  }
}

export function pluginRenameCommands(access: PluginRenameAccess) {
  return {
    confirmRename: (...args: TailOf<typeof confirmRename>) => confirmRename(access, ...args),
    renamePlugin: (...args: TailOf<typeof renamePlugin>) => renamePlugin(access, ...args),
  };
}
