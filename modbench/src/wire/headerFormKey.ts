import type { PluginAddress } from './pluginAddress';

// mEdit indexes a Plugin Header record at the null form of its plugin's file, which no other
// record can occupy.
const HEADER_PREFIX = '000000:';

export const headerFormKeyOf = ({ name }: PluginAddress): string => `${HEADER_PREFIX}${name}`;

export function headerPluginNameOf(formKey: string): string | undefined {
  return formKey.startsWith(HEADER_PREFIX) ? formKey.slice(HEADER_PREFIX.length) : undefined;
}
