import { headerFormKeyFor } from './formKeyIdentity';
import type { PluginRepository } from './PluginRepository';

/** The plugin identity `offerEslFlagRemoval` needs — `EditingController`'s `compile` and
 *  `createRecord`/`copyRecordAsNewRecord` all resolve one of these before the gesture that can
 *  hit the coherence refusal, so it takes the shape directly rather than importing
 *  `CompileTarget` from a module named for a different gesture. */
export interface EslFlagRemovalTarget {
  name: string;
  origin: string;
}

/** #290's coherence prompt (the maintainer's always-prompt rule for consequential state), shared
 *  by every gesture a removable ESL flag can refuse — compile, create, copy-as-new — the plugin
 *  no longer fits ESL and the typed marker says the flag is removable. Accept = an ordinary
 *  `is_light` header edit (the flag's one sanctioned door), after which the caller retries its
 *  own gesture; decline (or a refused edit) = false, and the caller's loud typed refusal stands,
 *  with the contradiction as the record of what to fix. `verb` names the retried gesture in the
 *  prompt's own words ("Compile", "Create the Record"). `showWarning`/`showError` are VS Code's
 *  own `window.show*Message`, injected so this stays testable with no `vscode` mock at all — the
 *  same DI shape `externalChangeDialog.ts`'s `runExternalChangeDialogs` already uses. */
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
