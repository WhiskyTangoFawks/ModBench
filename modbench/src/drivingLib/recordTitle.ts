import { headerPluginNameOf } from '../wire/headerFormKey';
import { pluginAddressOf, samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

export interface TitledColumn { plugin: string; origin: string; editorId?: string | null; isWinner: boolean }

/** The one place a record tab's title is derived: from the copy the tab is, else the winning one. */
export function recordTitle(formKey: string, columns: readonly TitledColumn[] | undefined, copy?: PluginAddress): string {
  const shown = copy
    ? columns?.find((c) => samePluginAddress(pluginAddressOf(c), copy))
    : columns?.find((c) => c.isWinner) ?? columns?.[0];
  return headerPluginNameOf(formKey) ?? shown?.editorId ?? formKey;
}
