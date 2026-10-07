import type { DownloadsTreeNode } from './DownloadsProvider';
import { gestureEntry, selectionArgument, singularArgument } from '../drivingLib/gestureEntry';
import { viewCopyValueText } from '../drivingLib/copyValue';

/** What the Downloads keys' and palette entries' `when` clauses read off the selection, since
 *  neither is handed a row. */
export interface DownloadsKeyContext {
  readonly singleFile: boolean;
  readonly singleFileWithMeta: boolean;
  readonly holdsFile: boolean;
  readonly holdsIncluded: boolean;
  readonly holdsExcluded: boolean;
}

export function downloadsKeyContext(selection: readonly DownloadsTreeNode[]): DownloadsKeyContext {
  const entry = gestureEntry<DownloadsTreeNode>(undefined, undefined, () => selection);
  const files = selectionArgument(entry, 'download');
  const single = singularArgument(entry, 'download');
  return {
    singleFile: single !== undefined,
    singleFileWithMeta: single?.row.hasMeta === true,
    holdsFile: files.length > 0,
    holdsIncluded: files.some((file) => !file.row.excluded),
    holdsExcluded: files.some((file) => file.row.excluded),
  };
}

/** The `args` the Downloads Ctrl+C passes, so the command other surfaces share knows the key is
 *  the Downloads view's. */
export const DOWNLOADS_KEY_ARGS = { view: 'modbench.downloads' } as const;

/** Downloads' own text for the catalog's one copy value id: each file's file name, or `undefined`
 *  unless the invocation is a download row or the Downloads key's args. */
export const downloadsCopyValueText = (viewSelection: () => readonly DownloadsTreeNode[]) =>
  viewCopyValueText<DownloadsTreeNode, 'download'>(DOWNLOADS_KEY_ARGS.view, ['download'], (row) => row.row.name, viewSelection);
