/** An unmarked cell does not merely omit a badge, it paints a verdict. Gated on
 *  `comparisonComplete` alone: the sweep is whole-set, so a changed load order leaves stale
 *  winners until it re-runs (ADR-0013). */
export function recordPanelIncompleteMessage(comparisonComplete: boolean): string | undefined {
  if (comparisonComplete) return undefined;
  return 'This record\'s comparison is not complete: the colours are not final.';
}
