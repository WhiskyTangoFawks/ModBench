import { headerPluginNameOf } from '../wire/headerFormKey';

interface TitledColumn { editorId?: string | null; isWinner: boolean }

/** The one place a record tab's title is derived. */
export function recordTitle(formKey: string, columns: readonly TitledColumn[] | undefined): string {
  const shown = columns?.find((c) => c.isWinner) ?? columns?.[0];
  return headerPluginNameOf(formKey) ?? shown?.editorId ?? formKey;
}
