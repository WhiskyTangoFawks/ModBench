import type { SymbolOwner } from '../symbolNames/symbolNames';
import { failureReason, isReadFailed } from '../wire/readFailed';
import type { MEditClient } from './MEditClient';

/** The plugins mEdit reads, as an owner of files that name a plugin: by a FormKey, or a master. mEdit holds the unsaved
 *  plugin source handed to it, so `held` adds nothing. */
export function recordIndexReferences(client: Pick<MEditClient, 'getPluginNameReferences'>): SymbolOwner {
  return {
    async read({ name }) {
      const copies = await client.getPluginNameReferences(name);
      if (isReadFailed(copies)) return { references: [], leftOut: [`the plugins mEdit reads: ${failureReason(copies)}`] };
      return { references: copies.map(({ formKey, plugin }) => ({ copy: { formKey, plugin }, names: { name } })), leftOut: [] };
    },
  };
}
