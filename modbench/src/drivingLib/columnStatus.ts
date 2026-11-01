import { copyColumnKey } from '../wire/columnKey';
import type { ColumnStatus, UnreadableSource } from '../wire/messages';
import { samePluginAddress } from '../wire/pluginAddress';

interface CopyFacts {
  readonly plugin: string;
  readonly origin: string;
  readonly column?: string | null;
  readonly isPartialForm: boolean;
  readonly isInOverwrite: boolean;
  readonly parseDiagnosis?: string | null;
}

interface PluginFacts {
  readonly name: string;
  readonly origin: string;
  readonly isImmutable?: boolean;
  readonly isCompiledPlugin?: boolean;
  readonly pluginSourceUnreadable?: UnreadableSource | null;
}

/** What the instance says of a copy's plugin: the mod whose file the game loads instead, or that the game loads none. */
export interface Standing {
  readonly overriddenBy: string | null;
  readonly notActive: boolean;
}

export const NO_STANDING: Standing = { overriddenBy: null, notActive: false };

/** editor.md, A column's header, the Status table: the first row that applies. No plugin facts read as a plugin that is
 *  not compiled, so the copy reads as one nothing edits. */
export function copyStatus(copy: CopyFacts, plugin: PluginFacts | undefined, { overriddenBy, notActive }: Standing): ColumnStatus | null {
  if (copy.parseDiagnosis != null) return { label: '(parse failure)', reason: copy.parseDiagnosis };
  if (overriddenBy !== null) return { label: '(overridden)', reason: `The game loads ${overriddenBy}’s file instead.` };
  if (notActive) return { label: '(not active)', reason: 'The game does not load it, so no other copy is compared.' };
  if (copy.isPartialForm) return { label: '(Partial Form)', reason: 'The game ignores this copy’s own fields.' };
  if (plugin?.isImmutable === true) return { label: '(read-only)', reason: 'The game’s plugins are not edited.' };
  if (copy.isInOverwrite) {
    return {
      label: '(read-only)',
      reason: 'Overwrite is not a mod; move the plugin into a mod and init source mod that mod.',
    };
  }
  if (plugin?.isCompiledPlugin !== true) {
    return {
      label: '(read-only)',
      reason: '“Init Source Mod”, or “Decompile Plugin” in a source mod, in this header’s menu, '
        + 'makes it editable.',
    };
  }
  const unreadable = plugin.pluginSourceUnreadable;
  if (unreadable != null) {
    return {
      label: '(read-only)',
      reason: `${unreadable.reason} Its records are its plugin file’s.`
        + (unreadable.decompileRepairs ? ' “Decompile Plugin”, in this header’s menu, makes it editable.' : ''),
    };
  }
  return null;
}

export const pluginOf = (plugins: readonly PluginFacts[] | null, copy: CopyFacts): PluginFacts | undefined =>
  plugins?.find((p) => samePluginAddress(p, { name: copy.plugin, origin: copy.origin }));

/** Each column that has a status, by its column key. The tab's own file carries the standing; the other columns are compared copies. */
export function columnStatuses(
  copies: readonly CopyFacts[], plugins: readonly PluginFacts[] | null, file: { readonly column: string | undefined; readonly standing: Standing },
): Record<string, ColumnStatus> {
  return Object.fromEntries(copies.flatMap((copy) => {
    const column = copyColumnKey(copy);
    const status = copyStatus(copy, pluginOf(plugins, copy), column === file.column ? file.standing : NO_STANDING);
    return status === null ? [] : [[column, status]];
  }));
}
