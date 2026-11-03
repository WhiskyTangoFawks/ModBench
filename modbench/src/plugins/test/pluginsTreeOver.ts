import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { RecordBrowser } from '../RecordBrowser';
import { PluginsTreeProvider } from '../PluginsTreeProvider';
import { recordingReporter } from '../../test/surfacingDoubles';
import { NO_MOD_STATUSES } from '../../test/noModStatuses';

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
    publishFailedToRead: () => undefined,
    publishSourceUnreadable: () => undefined,
    publishSortingErrors: () => undefined,
    publishSortingWarnings: () => undefined,
    publishSortingInfo: () => undefined,
    publishRuleFiles: () => undefined,
    modStatuses: NO_MOD_STATUSES,
    fileReads: { checksum: () => Promise.resolve(undefined), version: () => Promise.resolve(undefined), readable: () => Promise.resolve(false) },
    reporter: recordingReporter(),
    ...overrides,
  });
}
