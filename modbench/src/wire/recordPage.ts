import type { ColumnCopy, ViewState } from './messages';
import { isColumnCopies, isString, isViewState } from './messages';
import { isReadFailed, type ReadFailed } from './readFailed';

/** What the host sets on a record page's `window` before its script runs: the file's page names its
 *  record, columns and place; a page whose read failed carries the failure. */
export type RecordPageGlobals = {
  mEditFormKey?: string;
  mEditColumns?: ColumnCopy[];
  mEditViewState?: ViewState;
  mEditLoadError?: ReadFailed;
};

function held<T>(page: object, name: string, holds: (value: unknown) => value is T): T | undefined {
  const value: unknown = Reflect.get(page, name);
  if (value === undefined) return undefined;
  if (!holds(value)) throw new Error(`Expected the page's "${name}" to be of its wire type.`);
  return value;
}

/** The page's globals, each as the host set it. A global that is set and not of its type throws. */
export function readRecordPageGlobals(page: object): RecordPageGlobals {
  const [mEditFormKey, mEditColumns, mEditViewState, mEditLoadError] = [
    held(page, 'mEditFormKey', isString), held(page, 'mEditColumns', isColumnCopies),
    held(page, 'mEditViewState', isViewState), held(page, 'mEditLoadError', isReadFailed),
  ];
  return {
    ...(mEditFormKey !== undefined && { mEditFormKey }), ...(mEditColumns && { mEditColumns }),
    ...(mEditViewState && { mEditViewState }), ...(mEditLoadError && { mEditLoadError }),
  };
}
