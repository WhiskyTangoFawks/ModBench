import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { pluginCommands, type PluginCommands } from '../pluginCommands/plugins';

type PluginCommandsClient = Parameters<typeof pluginCommands>[0]['client'];

/** Plugin commands bound to `adapter` and a client that answers only what a test fixes. */
export function pluginCommandsWith(adapter: InstanceAdapter, client: Partial<PluginCommandsClient> = {}): PluginCommands {
  const unanswered = () => Promise.reject(new Error('this test fixed no answer'));
  return pluginCommands({
    adapter,
    client: {
      getPlugins: client.getPlugins?.bind(client) ?? unanswered,
      getRenameSourceChanges: client.getRenameSourceChanges?.bind(client) ?? unanswered,
      moveLastWritten: client.moveLastWritten?.bind(client) ?? unanswered,
      getCreatablePluginExtensions: client.getCreatablePluginExtensions?.bind(client) ?? unanswered,
      getPluginDependants: client.getPluginDependants?.bind(client) ?? unanswered,
      repairPreviews: client.repairPreviews?.bind(client) ?? unanswered,
      decompileAndRepair: client.decompileAndRepair?.bind(client) ?? unanswered,
    },
  });
}
