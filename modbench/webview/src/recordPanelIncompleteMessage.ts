/** An unmarked cell does not merely omit a badge, it paints a verdict. Gated on
 *  `conflictsComputed` alone: the sweep is whole-set, so a changed load order leaves stale
 *  winners until it re-runs (ADR-0013). */
export function recordPanelIncompleteMessage(conflictsComputed: boolean): string | undefined {
  if (conflictsComputed) return undefined;
  return 'This record\'s comparison is not yet complete: conflict information has not been '
    + 'computed for every plugin, so the colouring here is not final.';
}
