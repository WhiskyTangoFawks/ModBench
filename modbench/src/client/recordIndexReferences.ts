import { sameName, type PluginSymbol, type SymbolOwner } from '../symbolNames/symbolNames';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { isRefused, type MEditClient } from './MEditClient';

const isThePlugin = (plugin: PluginSymbol, symbol: PluginSymbol): boolean => sameName(plugin.name, symbol.name) && sameName(plugin.origin, symbol.origin);

const MEDIT_READS = 'the plugins mEdit reads';

/** The plugins mEdit reads, as an owner of files that name a plugin: by a FormKey, or a master. mEdit holds the unsaved
 *  plugin source handed to it, and Source reads the FormKey under a place itself. */
export function recordIndexReferences(client: Pick<MEditClient, 'getPluginNameReferences' | 'getRenameSourceChanges' | 'moveLastWritten'>): SymbolOwner {
  return {
    nameAt: () => Promise.resolve(undefined),
    async read({ name }) {
      const copies = await client.getPluginNameReferences(name);
      if (isReadFailed(copies)) return { references: [], leftOut: [`${MEDIT_READS}: ${failureReason(copies)}`] };
      return { references: copies.map(({ formKey, plugin }) => ({ copy: { formKey, plugin }, names: { name } })), leftOut: [] };
    },
    async plan(symbol, newName) {
      const changes = await client.getRenameSourceChanges(symbol, newName);
      if (isRefused(changes)) return { refused: changes.message };
      const copies = await client.getPluginNameReferences(symbol.name);
      // The renamed plugin's own copies follow its file.
      const inNoSource = isReadFailed(copies)
        ? [`${MEDIT_READS}: ${failureReason(copies)}`]
        : copies.filter(({ plugin, inPluginSource }) => !inPluginSource && !isThePlugin(plugin, symbol))
          .map(({ formKey, plugin }) => `${formKey} in ${plugin.name} (${plugin.origin})`);
      const { treeName, moves, deletions, documents, leftBehind } = changes;
      return {
        changes: { moves, deletions, documents },
        cannotFollow: [...leftBehind.map(({ plugin, reason }) => `${plugin.name} (${plugin.origin}): ${reason}`), ...inNoSource],
        commit: async () => {
          const moved = await client.moveLastWritten(symbol, treeName, newName);
          if (isRefused(moved)) throw new Error(moved.message);
        },
      };
    },
  };
}
