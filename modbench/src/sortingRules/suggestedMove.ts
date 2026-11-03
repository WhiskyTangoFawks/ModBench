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
  group: 'after',
};

/** The nearest place a broken rule's first plugin keeps it: beside the rule's second plugin. A rule about one plugin has none. */
export function suggestedMove({ rule, plugins }: BrokenRule): SuggestedMove | undefined {
  const side = SIDE[rule];
  const [mover, anchor] = plugins;
  return side && mover && anchor && { mover, side, anchor };
}
