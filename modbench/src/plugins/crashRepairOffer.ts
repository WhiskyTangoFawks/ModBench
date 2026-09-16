import type { CrashRepairOffer } from '../medit/client';
import type { AskQuestion } from '../dialog';

/** Working tree first, so VS Code focuses it: an interrupted compile means the user was compiling
 *  their own working tree, so recovering to it matches intent. */
export const REPAIR_WORKING_TREE_BUTTON = 'Compile from Working Tree';
export const REPAIR_AT_MAIN_BUTTON = 'Compile at main';

/** The detail names exactly what was detected — an unfinished journal marker versus a binary that
 *  could not be read — never a generic "something's wrong". */
export function messageFor(offer: CrashRepairOffer): { message: string; detail: string } {
  const message = `${offer.plugin} (in ${offer.origin}) needs its binary rebuilt.`;
  const what = offer.reason === 'InterruptedCompile'
    ? 'A previous Save & Compile looks like it was interrupted before it finished — the binary ' +
      'on disk does not match what Modbench last wrote.'
    : 'The compiled binary is missing or could not be read.';
  const detail = `${what} Compile now from your working tree, or restore the pristine version at ` +
    '"main". Declining leaves it exactly as it is — you\'ll be asked again next time this reconciles.';
  return { message, detail };
}

/** Called only when the user accepted — `atRef` is `undefined` for "Compile from Working Tree"
 *  (the normal Save & Compile source) or `'main'` for "Compile at main", the same two values
 *  `LoadOrderController.compile`'s own `atRef` parameter already takes. */
export type AcceptCrashRepair = (offer: CrashRepairOffer, atRef: string | undefined) => Promise<void>;

/** One native modal per offer, shown sequentially — never two racing each other. Esc/dismiss is a
 *  no-op: nothing is written, and the offer re-appears at the next reconcile because nothing
 *  clears the journal marker on a decline. */
export async function presentCrashRepairOffers(
  offers: readonly CrashRepairOffer[],
  show: AskQuestion,
  onAccept: AcceptCrashRepair,
): Promise<void> {
  for (const offer of offers) {
    const { message, detail } = messageFor(offer);
    // Sequential, deliberately not Promise.all'd: the next offer's modal must not be requested
    // until this one settles.
    const choice = await show(message, { modal: true, detail }, REPAIR_WORKING_TREE_BUTTON, REPAIR_AT_MAIN_BUTTON);
    if (choice === REPAIR_WORKING_TREE_BUTTON) await onAccept(offer, undefined);
    else if (choice === REPAIR_AT_MAIN_BUTTON) await onAccept(offer, 'main');
  }
}
