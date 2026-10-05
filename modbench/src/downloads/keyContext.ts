import { DownloadNode, type DownloadsTreeNode } from './DownloadsProvider';
import { gestureEntry, kindGuard, selectionArgument, singularArgument, type GestureEntry } from '../drivingLib/gestureEntry';

const isDownloadsRow = kindGuard<DownloadsTreeNode>()(['download', 'error']);

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
export function downloadsCopyValueText(
  viewSelection: () => readonly DownloadsTreeNode[],
): (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined {
  const names = (entry: GestureEntry<DownloadsTreeNode>) =>
    selectionArgument(entry, 'download').map((row) => row.row.name).join('\n');
  return (clicked, allSelected) => {
    if (typeof clicked === 'object' && clicked !== null && Reflect.get(clicked, 'view') === DOWNLOADS_KEY_ARGS.view) {
      return names({ selection: viewSelection() });
    }
    if (!(clicked instanceof DownloadNode)) return undefined;
    return names(gestureEntry(clicked, allSelected?.length ? allSelected.filter(isDownloadsRow) : undefined, viewSelection));
  };
}
