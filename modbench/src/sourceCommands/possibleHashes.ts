import type { MEditClient } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { PossibleHashes } from '../manifestAdapter/manifestAdapter';

export const possibleHashesOf = (client: Pick<MEditClient, 'getFlaggedPluginHashes'>, adapter: Pick<InstanceAdapter, 'gameRelease'>): PossibleHashes =>
  async (files) => client.getFlaggedPluginHashes(await adapter.gameRelease(), files);
