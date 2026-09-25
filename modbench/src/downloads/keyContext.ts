import type { DownloadNode, DownloadsTreeNode } from './DownloadsProvider';

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
