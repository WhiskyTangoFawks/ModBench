import type { PluginAddress } from './pluginAddress';

// A full stop before "; " would read ".;".
export const joinedReasons = (reasons: readonly string[]): string =>
  reasons.map((reason, i) => (i < reasons.length - 1 ? reason.replace(/\.$/, '') : reason)).join('; ');

export const joinedSentences = (statements: readonly string[]): string =>
  statements.map((statement, i) => (i < statements.length - 1 && !statement.endsWith('.') ? `${statement}.` : statement)).join(' ');

/** common.md, States, story 6. */
export const lastGoodReadMessage = (reasons: readonly string[]): string | undefined =>
  reasons.length === 0 ? undefined : `Showing the last good read: ${joinedReasons(reasons)}`;

export const pluginNamed = ({ name, origin }: PluginAddress): string => `"${name}" (${origin})`;

export const pluginReason = (plugin: PluginAddress, reason: string): string => `${pluginNamed(plugin)}: ${reason}`;
