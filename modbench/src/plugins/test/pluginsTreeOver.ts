import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { RecordBrowser } from '../RecordBrowser';
import { PluginsTreeProvider } from '../PluginsTreeProvider';

type PluginsTreeProviderOptions = ConstructorParameters<typeof PluginsTreeProvider>[0];

export function pluginsTreeOver(
  instance: PluginsTreeProviderOptions['instance'],
  overrides: Partial<Omit<PluginsTreeProviderOptions, 'instance' | 'client'>> & { client?: InMemoryMEditClient } = {},
): PluginsTreeProvider {
  const client = overrides.client ?? new InMemoryMEditClient();
  return new PluginsTreeProvider({
    instance,
    client,
    records: new RecordBrowser(client),
    publishDiagnoses: () => undefined,
    publishChangedOutside: () => undefined,
    log: () => undefined,
    dataFolderFile: () => undefined,
    ...overrides,
  });
}
