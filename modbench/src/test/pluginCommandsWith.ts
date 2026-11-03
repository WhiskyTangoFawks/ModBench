import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { PlaceMods } from '../pluginCommands/decompileAndRepair';
import { pluginCommands, type PluginCommands } from '../pluginCommands/plugins';

type PluginCommandsClient = Parameters<typeof pluginCommands>[0]['client'];

/** Plugin commands bound to `adapter`, a client that answers only what a test fixes, and the flow placing mods as the test makes it. */
export function pluginCommandsWith(
  adapter: InstanceAdapter, client: Partial<PluginCommandsClient> = {}, placeMods?: PlaceMods,
): PluginCommands {
  const unanswered = () => Promise.reject(new Error('this test fixed no answer'));
  return pluginCommands({
    adapter,
    placeMods: placeMods ?? unanswered,
    client: {
      getPlugins: client.getPlugins?.bind(client) ?? unanswered,
      getRenameSourceChanges: client.getRenameSourceChanges?.bind(client) ?? unanswered,
      moveLastWritten: client.moveLastWritten?.bind(client) ?? unanswered,
      getCreatablePluginExtensions: client.getCreatablePluginExtensions?.bind(client) ?? unanswered,
      decompileAndRepair: client.decompileAndRepair?.bind(client) ?? unanswered,
    },
  });
}
