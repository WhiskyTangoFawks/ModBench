import type { ChangeResult } from '../ports/changeResult';
import { errorMessage } from '../ports/errorMessage';
import { NO_FILE_CHANGES, type EntryOwner, type FileChanges, type HeldTexts, type Planned, type RenamePlan } from '../symbolNames/symbolNames';

/** The boxes whose files hold a symbol: the one that defines it, and each whose files name it. */
export interface SymbolOwners<Owner> {
  readonly definition: Owner;
  readonly references: readonly Owner[];
}

/** What Text documents gives a rename: the unsaved texts the owners read, and the edit that applies their changes,
 *  answering why it could not. */
export interface RenameEditing {
  readonly held: HeldTexts;
  readonly apply: (changes: readonly FileChanges[]) => Promise<string | undefined>;
}

const isRefused = (planned: Planned): planned is { readonly refused: string } => 'refused' in planned;

const changesAnything = ({ moves, deletions, documents }: FileChanges): boolean => moves.length + deletions.length + documents.length > 0;

/** Renames a symbol, carrying each reference to it (ADR-0028). Every owner `plan`s and writes nothing, and one refusal
 *  stops it. Then every owner's changes apply as one edit, and each owner commits, the definition's last. */
export async function change<Owner>(owners: SymbolOwners<Owner>, plan: (owner: Owner) => Promise<Planned>, apply: RenameEditing['apply']): Promise<ChangeResult> {
  const planned = await Promise.all([...owners.references, owners.definition].map(plan));
  const refused = planned.find(isRefused);
  if (refused !== undefined) return { applied: false, refusal: refused.refused };
  const plans = planned.filter((each): each is RenamePlan => !isRefused(each));

  const changes = plans.map((each) => each.changes);
  const unapplied = await apply(changes);
  if (unapplied !== undefined) return { applied: false, unapplied };
  const cannotFollow = plans.flatMap((each) => each.cannotFollow);
  for (const each of plans) {
    const committed = await each.commit();
    if ('failed' in committed) return { applied: false, failed: committed.failed, edited: changes.some(changesAnything), moved: changes.flatMap(({ moves }) => moves) };
    cannotFollow.push(...committed.cannotFollow);
  }
  return { applied: true, cannotFollow };
}

/** An owner whose part of a rename is a write at its commit: `write` answers each reference that could not follow, and
 *  its rejection is the commit's failure. */
export const committedBy = (write: () => Promise<readonly string[]>): EntryOwner => ({
  plan: () => Promise.resolve({
    changes: NO_FILE_CHANGES,
    cannotFollow: [],
    commit: () => write().then((cannotFollow) => ({ cannotFollow }), (err: unknown) => ({ failed: errorMessage(err) })),
  }),
});
