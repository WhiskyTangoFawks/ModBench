/** Whether the copy a plugin holds can be written: it is a compiled plugin, not the game folder's, and its
 *  plugin source reads (ADR-0007; editor.md, Columns, story 4). */
export const pluginCanBeEdited = (
  plugin: { isImmutable?: boolean; isCompiledPlugin?: boolean; pluginSourceUnreadable?: unknown },
): boolean => plugin.isCompiledPlugin === true && plugin.isImmutable !== true && plugin.pluginSourceUnreadable == null;
