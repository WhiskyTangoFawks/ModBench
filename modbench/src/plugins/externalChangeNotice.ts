import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from '../wire/pluginAddress';

/** plugins.md, Reporting, stories 4 and 5: a warning for each new state of a changed plugin's
 *  bytes, and one for each plugin whose plugin source is unreadable once in a session. Returns the
 *  unsubscribe. */
export function noticeExternalChanges(
  reporter: Pick<Reporter, 'report'>, notifications: Pick<MEditClient, 'onNotification'>,
): () => void {
  // Each mod's last settle: plugin name to the state of its bytes, null when they could not be read.
  const toldByMod = new Map<string, Map<string, string | null>>();
  const toldUnreadable = new Set<string>();

  const offChanges = notifications.onNotification('external-change', ({ origin, changedPlugins }) => {
    const told = toldByMod.get(origin);
    const now = new Map(changedPlugins.map((p) => [p.name, p.bytesSha256 ?? null]));
    toldByMod.set(origin, now);
    const fresh = [...now].filter(([name, state]) => !told?.has(name) || told.get(name) !== state).map(([name]) => name);
    if (fresh.length > 0) reporter.report('warning', `${fresh.join(', ')} in ${origin} changed outside Modbench`);
  });

  const offUnreadable = notifications.onNotification('plugin-source-unreadable', ({ plugins }) => {
    for (const plugin of plugins) {
      const key = pluginAddressKey(plugin);
      if (toldUnreadable.has(key)) continue;
      toldUnreadable.add(key);
      reporter.report(
        'warning', `${plugin.name} in ${plugin.origin}: plugin source unreadable: ${plugin.reason}`,
        plugin.decompileRepairs ? 'decompile writes it from the plugin file' : undefined);
    }
  });

  return () => { offChanges(); offUnreadable(); };
}
