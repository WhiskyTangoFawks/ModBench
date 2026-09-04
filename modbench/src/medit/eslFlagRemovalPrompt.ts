import { headerFormKeyFor } from './formKeyIdentity';
import type { PluginRepository } from './PluginRepository';

/** Deliberately not `CompileTarget`: create and copy-as-new reach this refusal too, so the
 *  shape is not named for one gesture. */
export interface EslFlagRemovalTarget {
  name: string;
  origin: string;
}

/** Accept performs an ordinary `is_light` header edit — the flag's one sanctioned door — and
 *  the caller retries its gesture; decline, or a refused edit, leaves the typed refusal
 *  standing. `verb` names that gesture in the prompt's words. */
export async function offerEslFlagRemoval(
  target: EslFlagRemovalTarget, refusalReason: string, verb: string,
  repository: PluginRepository,
  showWarning: (message: string, options: { modal: true }, ...items: string[]) => Thenable<string | undefined>,
  showError: (message: string) => void,
): Promise<boolean> {
  const accept = `Remove ESL Flag and ${verb}`;
  const choice = await showWarning(
    `"${target.name}" no longer fits ESL. Remove the ESL flag and ${verb.toLowerCase()}?\n\n${refusalReason}`,
    { modal: true }, accept);
  if (choice !== accept) return false;

  const outcome = await repository.editRecordField(
    headerFormKeyFor(target.name), target.name, target.origin, 'is_light', false);
  if (outcome.applied) return true;
  showError(`Modbench: Could not remove the ESL flag on "${target.name}" — ${outcome.message}`);
  return false;
}
