import type { ChangeResult } from '../ports/changeResult';
import type { GestureResult } from './agentGesture';

export interface Renamed<T> {
  /** The renamed thing as a message names it, such as `"Patch.esp" (ModA)`. */
  readonly named: string;
  readonly newName: string;
  readonly landed: T;
  /** What the definition writes last, such as `its file and lines`. */
  readonly definition: string;
  readonly couldNot?: string;
}

type Refused = { readonly applied: false; readonly refusal: string; readonly detail?: string };

const refused = <T>(refusal: string, detail?: string): GestureResult<T> => ({ applied: false, refusal, detail });

// symbols.md, The features, story 7. A move on disk is no change git can revert, so no message offers that way back.
export function renameOutcome<T>(result: ChangeResult | Refused, { named, newName, landed, definition, couldNot = `Could not rename ${named}` }: Renamed<T>): GestureResult<T> {
  if (result.applied) {
    const { cannotFollow } = result;
    return {
      applied: true,
      outcome: { landed: [landed], refused: [] },
      ...cannotFollow.length === 0 ? {} : {
        partial: [{ message: `Renamed ${named} to "${newName}". ${String(cannotFollow.length)} references to it could not follow.`, detail: cannotFollow.join('\n'), severity: 'warning' }],
      },
    };
  }
  if ('unapplied' in result) return refused(`${couldNot}: its references may be partly changed, and its files and folders partly moved.`, result.unapplied);
  if ('refusal' in result) return refused(result.refusal, 'detail' in result ? result.detail : undefined);
  if (!result.edited) return refused(`${couldNot}: ${definition} were not renamed.`, result.failed);
  const moved = result.moved.map(({ from, to }) => ` ${from} moved to ${to}.`).join('');
  return refused(`${couldNot}: its references were changed, and ${definition} were not.${moved}`, result.failed);
}
