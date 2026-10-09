/** Whether the copy a plugin holds can be written: it is tracked, not the game folder's, and its
 *  plugin source reads (ADR-0007; editor.md, Columns, story 4). */
export const pluginCanBeEdited = (
  plugin: { isImmutable?: boolean; isTracked?: boolean; pluginSourceUnreadable?: unknown },
): boolean => plugin.isTracked === true && plugin.isImmutable !== true && plugin.pluginSourceUnreadable == null;
