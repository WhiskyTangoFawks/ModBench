import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { pluginsCommands, type PluginsCommands } from '../pluginsCommands/plugins';

type PluginsCommandsClient = Parameters<typeof pluginsCommands>[0]['client'];

/** The Plugins commands bound to `adapter` and a client that answers only what a test fixes. */
export function pluginsCommandsWith(adapter: InstanceAdapter, client: Partial<PluginsCommandsClient> = {}): PluginsCommands {
  const unanswered = () => Promise.reject(new Error('this test fixed no answer'));
  return pluginsCommands({
    adapter,
    client: {
      getPlugins: client.getPlugins?.bind(client) ?? unanswered,
      getRenameSourceChanges: client.getRenameSourceChanges?.bind(client) ?? unanswered,
      moveLastWritten: client.moveLastWritten?.bind(client) ?? unanswered,
      getPluginDependants: client.getPluginDependants?.bind(client) ?? unanswered,
    },
  });
}
