import { DownloadNode, type DownloadsTreeNode } from './DownloadsProvider';

/** What the Downloads keys' and palette entries' `when` clauses read off the selection, since
 *  neither is handed a row. */
export interface DownloadsKeyContext {
  readonly singleFile: boolean;
  readonly singleFileWithMeta: boolean;
  readonly holdsFile: boolean;
  readonly holdsIncluded: boolean;
  readonly holdsExcluded: boolean;
}

export function selectedFiles(selection: readonly DownloadsTreeNode[]): DownloadNode[] {
  return selection.filter((row): row is DownloadNode => row.kind === 'download');
}

/** The one selected file, the Argument a singular gesture takes from the palette. */
export function singleSelectedFile(selection: readonly DownloadsTreeNode[]): DownloadNode | undefined {
  const [only, ...rest] = selection;
  return only?.kind === 'download' && rest.length === 0 ? only : undefined;
}

export function downloadsKeyContext(selection: readonly DownloadsTreeNode[]): DownloadsKeyContext {
  const files = selectedFiles(selection);
  const single = singleSelectedFile(selection);
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
  const names = (rows: readonly unknown[]) => rows.filter((row) => row instanceof DownloadNode).map((row) => row.row.name).join('\n');
  return (clicked, allSelected) => {
    if (typeof clicked === 'object' && clicked !== null && Reflect.get(clicked, 'view') === DOWNLOADS_KEY_ARGS.view) return names(viewSelection());
    if (!(clicked instanceof DownloadNode)) return undefined;
    return names(allSelected?.length ? allSelected : [clicked]);
  };
}
