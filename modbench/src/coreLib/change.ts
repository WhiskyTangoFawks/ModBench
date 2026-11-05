import { errorMessage } from '../ports/errorMessage';
import type { FileChanges, HeldTexts, PluginSymbol, RenamePlan, SymbolOwner } from '../symbolNames/symbolNames';

/** The boxes whose files hold a symbol: the one that defines it, and each whose files name it. */
export interface SymbolOwners {
  readonly definition: SymbolOwner;
  readonly references: readonly SymbolOwner[];
}

export interface Changing {
  readonly owners: SymbolOwners;
  readonly held: HeldTexts;
  /** Applies every owner's changes as one workspace edit; why it could not, or undefined. */
  readonly apply: (changes: readonly FileChanges[]) => Promise<string | undefined>;
}

/** `unapplied`: the edit failed, and may have partly landed. `failed`: a commit failed after the edit, which changed
 *  files when `edited`. */
export type ChangeResult =
  | { readonly applied: true; readonly cannotFollow: readonly string[] }
  | { readonly applied: false; readonly refusal: string }
  | { readonly applied: false; readonly unapplied: string }
  | { readonly applied: false; readonly failed: string; readonly edited: boolean };

type Planned = RenamePlan | { readonly refused: string };

const isRefused = (planned: Planned): planned is { readonly refused: string } => 'refused' in planned;

const changesAnything = ({ moves, deletions, documents }: FileChanges): boolean => moves.length + deletions.length + documents.length > 0;

/** Renames `symbol`, carrying each reference to it (ADR-0028). Every owner plans and writes nothing, and one refusal
 *  stops it. Then every owner's changes apply as one edit, and each owner commits, the definition's last. */
export async function change({ owners, held, apply }: Changing, symbol: PluginSymbol, newName: string): Promise<ChangeResult> {
  const planned = await Promise.all([...owners.references, owners.definition].map((owner) =>
    owner.plan(symbol, newName, held).catch((err: unknown): Planned => ({ refused: errorMessage(err) }))));
  const refused = planned.find(isRefused);
  if (refused !== undefined) return { applied: false, refusal: refused.refused };
  const plans = planned.filter((plan): plan is RenamePlan => !isRefused(plan));

  const changes = plans.map((plan) => plan.changes);
  const unapplied = await apply(changes);
  if (unapplied !== undefined) return { applied: false, unapplied };
  for (const plan of plans) {
    try {
      await plan.commit();
    } catch (err) {
      return { applied: false, failed: errorMessage(err), edited: changes.some(changesAnything) };
    }
  }
  return { applied: true, cannotFollow: plans.flatMap((plan) => plan.cannotFollow) };
}
