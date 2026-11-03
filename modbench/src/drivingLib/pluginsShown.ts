import type { PluginAddress } from '../wire/pluginAddress';

/** What the Plugins view's row shows of a plugin (plugins.md, A row, Plugin); what mEdit has not read yet is null. */
export interface PluginShown {
  readonly statuses: readonly { readonly status: string; readonly tooltip: string }[];
  readonly readOnly: boolean | null;
  readonly compiled: boolean | null;
  readonly masters: readonly string[] | null;
}

/** A broken sorting rule as the Plugins view's Sorting rules show it (plugins.md, Sorting rules). */
interface SortingRuleShown {
  readonly level: 'error' | 'warning' | 'info';
  readonly reason: string;
  readonly plugins: readonly { readonly origin: string; readonly filename: string }[];
}

/** The move that keeps `rule`: `mover` goes directly `drop.kind` of the plugin `drop.name`, in load order. */
interface SuggestedMoveShown {
  readonly rule: SortingRuleShown;
  readonly mover: PluginAddress;
  readonly drop: { readonly kind: string; readonly name?: string };
}

export interface PluginsShown {
  shown(plugin: PluginAddress): PluginShown;
  /** Why the order has not been judged yet; `undefined` once it has. No rules before then is not yet checked, not none broken. */
  sortingNotJudged(): string | undefined;
  brokenRules(): readonly SortingRuleShown[];
  suggestedMoves(): readonly SuggestedMoveShown[];
}
