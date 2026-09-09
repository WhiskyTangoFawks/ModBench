import { describe, it, expect } from 'vitest';
import type { MEditClient } from '../MEditClient';
import type { PluginFactsClient } from '../../../plugins/PluginsTreeProvider';

// Type-only: a `Pick` over the port's own query names satisfies the Plugins view's narrowed
// `PluginFactsClient`, without migrating that view. A typecheck failure here means the port's
// `getPlugins`/`getDiagnoses` signatures drifted from the repository's.
function assertPickSatisfiesPluginFactsClient(client: Pick<MEditClient, 'getPlugins' | 'getDiagnoses'>): PluginFactsClient {
  return client;
}

describe('MEditClient — Pick shape', () => {
  it('a Pick over getPlugins/getDiagnoses satisfies PluginFactsClient', () => {
    expect(typeof assertPickSatisfiesPluginFactsClient).toBe('function');
  });
});
