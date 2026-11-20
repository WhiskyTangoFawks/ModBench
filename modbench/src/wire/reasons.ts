import type { PluginAddress } from './pluginAddress';

export const joinedReasons = (reasons: readonly string[]): string =>
  reasons.map((reason, i) => (i < reasons.length - 1 ? reason.replace(/\.$/, '') : reason)).join('; ');

/** common.md, States, story 6. */
export const lastGoodReadMessage = (reasons: readonly string[]): string | undefined =>
  reasons.length === 0 ? undefined : `Showing the last good read: ${joinedReasons(reasons)}`;

export const quotedPluginName = ({ name, origin }: PluginAddress): string => `"${name}" (${origin})`;

export const pluginReason = (plugin: PluginAddress, reason: string): string => `${quotedPluginName(plugin)}: ${reason}`;
