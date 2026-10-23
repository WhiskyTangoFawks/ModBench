import type { ReadModStatus } from '../client';
import type { InstanceValue } from '../instanceLoader/instance';
import { linesWithoutFile, modsWithManifests } from '../instanceLoader/linesNotRestored';
import { originsOfLinesNotRestored } from '../pluginCommands/pluginsNotRestored';
import { pluginNameKey } from '../wire/pluginAddress';
import { isReadFailed } from '../wire/readFailed';
import { statusUnreadable } from './modStatuses';

interface NotRestoredRead {
  readonly origins: ReadonlyMap<string, string>;
  readonly undecided: readonly string[];
  readonly unread?: string;
}

/** The instance value with what the agent's plugin names need from the manifests. */
export type AgentValue = InstanceValue & { readonly notRestored?: NotRestoredRead };

/** The origin list_plugins shows for a plugin: the mod that names a line with no file, otherwise the origin the load order holds. */
export const originShown = (value: Pick<AgentValue, 'notRestored'>, { name, origin, path }: { name: string; origin: string; path?: string }): string =>
  (path === undefined ? value.notRestored?.origins.get(pluginNameKey(name)) : undefined) ?? origin;

// A line is undecided when a mod above the one that names it, or any mod when none names it, has a status that cannot be read.
function undecidedLines(value: InstanceValue, mods: readonly string[], origins: ReadonlyMap<string, string>, unreadMods: ReadonlySet<string>): string[] {
  const firstUnread = mods.findIndex((mod) => unreadMods.has(mod));
  if (firstUnread < 0) return [];
  return linesWithoutFile(value).filter((name) => {
    const namedBy = origins.get(pluginNameKey(name));
    return namedBy === undefined || firstUnread < mods.indexOf(namedBy);
  });
}

export async function withNotRestored(value: InstanceValue, readStatus: ReadModStatus): Promise<AgentValue> {
  const mods = modsWithManifests(value);
  if (mods.length === 0 || linesWithoutFile(value).length === 0) return value;
  const answer = await readStatus(mods);
  if (isReadFailed(answer)) {
    const origins = new Map<string, string>();
    return { ...value, notRestored: { origins, undecided: undecidedLines(value, mods, origins, new Set(mods)), unread: statusUnreadable(answer) } };
  }
  const gone = new Map(answer.map((status) => [status.mod, status.gone]));
  const origins = originsOfLinesNotRestored(mods, linesWithoutFile(value), (mod) => gone.get(mod) ?? []);
  const unreadable = answer.filter((status) => status.unreadable);
  const unread = unreadable.map(({ mod, unreadable: why }) => `the status of "${mod}" could not be read: ${why?.why}`).join('; ');
  return { ...value, notRestored: { origins, undecided: undecidedLines(value, mods, origins, new Set(unreadable.map(({ mod }) => mod))), unread } };
}
