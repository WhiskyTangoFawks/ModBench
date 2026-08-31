import type { CrashRepairOffer } from './ApiClient';

/** The loud detect-and-offer's two buttons — "the offer names the affected plugin(s) and
 *  what happened; accepting compiles (user's choice: working tree or main)". Working tree first/
 *  default (VS Code focuses/Enters the first button): an interrupted compile means the user was
 *  compiling their own working tree, so recovering to it matches intent, and unlike the
 *  external-change dialog there is no meta tell here to justify anything cleverer. */
export const REPAIR_WORKING_TREE_BUTTON = 'Compile from Working Tree';
export const REPAIR_AT_MAIN_BUTTON = 'Compile at main';

/** The modal's message + detail text — the evidence shown, not hidden, same posture the
 *  external-change dialog took: the detail names exactly what was detected (an unfinished journal marker vs a binary
 *  that could not be read), never a generic "something's wrong". */
export function messageFor(offer: CrashRepairOffer): { message: string; detail: string } {
  const message = `${offer.plugin} (in ${offer.origin}) needs its binary rebuilt.`;
  const what = offer.reason === 'InterruptedCompile'
    ? 'A previous Save & Compile looks like it was interrupted before it finished — the binary ' +
      'on disk no longer matches what Modbench last wrote.'
    : 'The compiled binary is missing or could not be read.';
  const detail = `${what} Compile now from your working tree, or restore the pristine version at ` +
    '"main". Declining leaves it exactly as it is — you\'ll be asked again next time this reconciles.';
  return { message, detail };
}

/** The one shape this module needs from `vscode.window.showWarningMessage` — injected so the
 *  sequencing below is testable without a VS Code host, same idiom `externalChangeDialog.ts`
 *  already establishes for the sibling dialog. */
export type ShowCrashRepairOffer = (
  message: string, options: { modal: true; detail: string }, ...buttons: string[]
) => Thenable<string | undefined> | Promise<string | undefined>;

/** Called only when the user accepted — `atRef` is `undefined` for "Compile from Working Tree"
 *  (the normal Save & Compile source) or `'main'` for "Compile at main", the same two values
 *  `LoadOrderController.compile`'s own `atRef` parameter already takes. */
export type AcceptCrashRepair = (offer: CrashRepairOffer, atRef: string | undefined) => Promise<void>;

/**
 * One native modal **per offer**, shown **sequentially** — never two racing each other, the
 * same posture `runExternalChangeDialogs` already established for the sibling dialog (see
 * that module's own doc comment). Esc/dismiss (the resolved value matching neither button) is a
 * true no-op: nothing is written, `onAccept` is never called, and the offer re-appears at the next
 * reconcile by construction — nothing here or downstream clears the journal marker or fixes the
 * missing binary on a decline.
 */
export async function presentCrashRepairOffers(
  offers: readonly CrashRepairOffer[],
  show: ShowCrashRepairOffer,
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
