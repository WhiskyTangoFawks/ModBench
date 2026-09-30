import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from './trackedRepositories';

// package.json's title for the gesture that decompiles an untracked plugin of a mod.
const TRACK_PLUGIN_TITLE = 'Track Plugin…';

/** plugins.md, Reporting, stories 4 and 5: a warning for each new state of a changed plugin's
 *  bytes, and one for each untracked plugin of a tracked mod once in a session. Returns the
 *  unsubscribe. */
export function noticeExternalChanges(
  reporter: Pick<Reporter, 'report'>, notifications: Pick<MEditClient, 'subscribe'>,
): () => void {
  // Each mod's last settle: plugin name to the state of its bytes, null when they could not be read.
  const toldByMod = new Map<string, Map<string, string | null>>();
  const toldUntracked = new Set<string>();

  const offChanges = notifications.subscribe('external-change', ({ origin, changedPlugins }) => {
    const told = toldByMod.get(origin);
    const now = new Map((changedPlugins ?? []).map((p) => [p.name, p.bytesSha256 ?? null]));
    toldByMod.set(origin, now);
    const fresh = [...now].filter(([name, state]) => !told?.has(name) || told.get(name) !== state).map(([name]) => name);
    if (fresh.length > 0) reporter.report('warning', `${fresh.join(', ')} in ${origin} changed outside Modbench`);
  });

  const offUntracked = notifications.subscribe('untracked-plugins', ({ origin, keys }) => {
    for (const plugin of keys) {
      const key = pluginAddressKey(plugin, origin);
      if (toldUntracked.has(key)) continue;
      toldUntracked.add(key);
      reporter.report('warning', `${plugin} in ${origin} has no plugin source`, `run "${TRACK_PLUGIN_TITLE}" on it to decompile it`);
    }
  });

  return () => { offChanges(); offUntracked(); };
}
