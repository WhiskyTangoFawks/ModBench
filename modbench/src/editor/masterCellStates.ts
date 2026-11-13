import { copyColumnKey } from '../wire/columnKey';
import type { CompareResult } from '../wire/messages';

type FieldDiff = CompareResult['diffs'][number];

/** The first column's cell that holds a value reads Master, or OnlyOne when no other copy is compared, in every row
 *  mEdit left it unstated (editor-conflicts.md, Cells). A compare of several records states every cell itself. */
export function withMasterCellStates(compare: CompareResult): CompareResult {
  const [first] = compare.overrides;
  if (first === undefined) return compare;
  const column = copyColumnKey(first);
  const state = compare.overrides.length === 1 ? 'OnlyOne' : 'Master';
  const filled = (diff: FieldDiff): FieldDiff => ({
    ...diff,
    ...(diff.cellStatesByFocus == null && diff.cellStates[column] === undefined && diff.values[column] != null
      && { cellStates: { ...diff.cellStates, [column]: state } }),
    ...(diff.children != null && { children: diff.children.map(filled) }),
  });
  return { ...compare, diffs: compare.diffs.map(filled) };
}
