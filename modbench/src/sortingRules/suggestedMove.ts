import type { BrokenRule, PluginRef } from './judge';

/** `mover` goes directly `side` of `anchor`. */
export interface SuggestedMove {
  mover: PluginRef;
  side: 'before' | 'after';
  anchor: PluginRef;
}

const SIDE: Partial<Record<BrokenRule['rule'], SuggestedMove['side']>> = {
  master: 'before',
  masterFlag: 'before',
  blueprint: 'after',
  loadAfter: 'after',
};

/** The nearest place a broken rule's first plugin keeps it: its placement, else beside the rule's second plugin. A rule about one plugin has none. */
export function suggestedMove({ rule, plugins, placement }: BrokenRule): SuggestedMove | undefined {
  const [mover] = plugins;
  if (placement) return mover && { mover, ...placement };
  const side = SIDE[rule];
  const anchor = plugins[1];
  return side && mover && anchor && { mover, side, anchor };
}
