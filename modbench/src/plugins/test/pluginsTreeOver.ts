import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { PluginsTreeProvider, type PluginsTreeProviderOptions } from '../PluginsTreeProvider';

export function pluginsTreeOver(
  instance: PluginsTreeProviderOptions['instance'],
  overrides: Partial<Omit<PluginsTreeProviderOptions, 'instance' | 'client'>> & { client?: InMemoryMEditClient } = {},
): PluginsTreeProvider {
  const client = overrides.client ?? new InMemoryMEditClient();
  return new PluginsTreeProvider({
    instance,
    client,
    records: new PluginTreeProvider(client),
    publishDiagnoses: () => undefined,
    publishChangedOutside: () => undefined,
    log: () => undefined,
    dataFolderFile: () => undefined,
    ...overrides,
  });
}
