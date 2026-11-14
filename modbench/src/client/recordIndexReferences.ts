import { COMMITTED, namesPlugin, samePlugin, type HeldTexts, type PluginSymbol, type SymbolOwner } from '../symbolNames/symbolNames';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { isRefused, type MEditClient, type RenameSourceAsked } from './MEditClient';

const MEDIT_READS = 'the plugins mEdit reads';

/** Each file of a source folder a build reads by the renamed plugin's name, and the name it takes, relative to the folder. */
export type SourceFilesOf = (symbol: PluginSymbol, newName: string, held: HeldTexts) => Promise<readonly NonNullable<RenameSourceAsked['sourceFiles']>[number][]>;

/** The plugins mEdit reads, as an owner of files that name a plugin: by a FormKey, or a master. A rename moves the files
 *  `sourceFilesOf` names too. */
export function recordIndexReferences(
  client: Pick<MEditClient, 'getPluginNameReferences' | 'getRenameSourceChanges' | 'moveLastWritten' | 'getPluginSourceNames'>, sourceFilesOf: SourceFilesOf,
): SymbolOwner {
  return {
    // Where mEdit cannot answer, the other kinds asking of the same text say so.
    async nameAt(file, text, offset) {
      const names = await client.getPluginSourceNames(text, file, offset);
      const plugin = isReadFailed(names) ? undefined : names.find(({ kind }) => kind === 'Plugin');
      return plugin && { name: plugin.value };
    },
    async read({ name }) {
      const copies = await client.getPluginNameReferences(name);
      if (isReadFailed(copies)) return { references: [], leftOut: [`${MEDIT_READS}: ${failureReason(copies)}`] };
      return { references: copies.map(({ formKey, plugin }) => ({ copy: { formKey, plugin }, names: { name } })), leftOut: [] };
    },
    async plan(symbol, newName, held, plugins) {
      // A FormKey names a plugin by its file name alone.
      const namedByFileName = namesPlugin({ name: symbol.name }, symbol, plugins);
      const changes = await client.getRenameSourceChanges(symbol, newName, { namedByFileName, sourceFiles: [...await sourceFilesOf(symbol, newName, held)] });
      if (isRefused(changes)) return { refused: changes.message };
      const copies = namedByFileName ? await client.getPluginNameReferences(symbol.name) : [];
      // The renamed plugin's own copies follow its file.
      const inNoSource = isReadFailed(copies)
        ? [`${MEDIT_READS}: ${failureReason(copies)}`]
        : copies.filter(({ plugin, inPluginSource }) => !inPluginSource && !samePlugin(plugin, symbol))
          .map(({ formKey, plugin }) => `${formKey} in ${plugin.name} (${plugin.origin})`);
      const { treeName, moves, deletions, documents, leftBehind } = changes;
      return {
        changes: { moves, deletions, documents },
        cannotFollow: [...leftBehind.map(({ plugin, reason }) => `${plugin.name} (${plugin.origin}): ${reason}`), ...inNoSource],
        commit: async () => {
          const moved = await client.moveLastWritten(symbol, treeName, newName);
          return isRefused(moved) ? { failed: moved.message } : COMMITTED;
        },
      };
    },
  };
}
