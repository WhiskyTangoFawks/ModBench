import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { NewRepositories } from '../pluginCommands/decompileAndRepair';
import { pluginCommands, type PluginCommands } from '../pluginCommands/plugins';

type PluginCommandsClient = Parameters<typeof pluginCommands>[0]['client'];

/** Plugin commands bound to `adapter`, a client that answers only what a test fixes, and the repositories made as the test
 *  makes them. */
export function pluginCommandsWith(
  adapter: InstanceAdapter, client: Partial<PluginCommandsClient> = {}, newRepositories: Partial<NewRepositories> = {},
): PluginCommands {
  const unanswered = () => Promise.reject(new Error('this test fixed no answer'));
  return pluginCommands({
    adapter,
    newRepositories: { of: newRepositories.of ?? unanswered, folderManifestRemovedOrWhy: newRepositories.folderManifestRemovedOrWhy ?? unanswered },
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
