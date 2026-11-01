import type { BrokenRule, PluginRef } from './judge';
import type { LootEntry, LootFile } from './lootMetadata';

const fold = (filename: string): string => filename.toLowerCase();

const shown = ({ name, display }: LootFile): string => (display === undefined ? `"${name}"` : display);

const withDetail = (reason: string, { detail }: LootFile): string => (detail === undefined ? reason : `${reason} ${detail}`);

// A file named in several matching entries counts once, the first statement of it.
function distinct(files: readonly LootFile[]): LootFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(fold(file.name))) return false;
    seen.add(fold(file.name));
    return true;
  });
}

function unevaluated(plugin: PluginRef, condition: string, what: string, consequence: string, source: LootFile['source']): BrokenRule {
  return {
    rule: 'condition', level: 'warning', plugins: [plugin], source,
    reason: `"${plugin.filename}": the condition ${condition} on ${what} cannot be evaluated, so ${consequence}.`,
  };
}

function judgePlugin(
  order: readonly PluginRef[], index: number, entries: readonly LootEntry[], isPresent: (filename: string) => boolean,
): BrokenRule[] {
  const plugin = order[index];
  if (plugin === undefined) return [];
  const matching = entries.filter((entry) => entry.matches(plugin.filename));
  const filesOf = (key: 'req' | 'inc' | 'after'): LootFile[] => distinct(matching.flatMap((entry) => entry[key]));
  const requirements = filesOf('req').flatMap((file): BrokenRule[] => {
    if (file.condition !== undefined) return [unevaluated(plugin, file.condition, 'a requirement', `"${file.name}" is not checked`, file.source)];
    if (isPresent(file.name)) return [];
    return [{ rule: 'requirement', level: 'error', plugins: [plugin], source: file.source, reason: withDetail(`"${plugin.filename}" requires ${shown(file)}, which is missing.`, file) }];
  });
  const incompatibilities = filesOf('inc').flatMap((file): BrokenRule[] => {
    if (file.condition !== undefined) return [unevaluated(plugin, file.condition, 'an incompatibility', `"${file.name}" is not checked`, file.source)];
    if (!isPresent(file.name)) return [];
    return [{ rule: 'incompatibility', level: 'error', plugins: [plugin], source: file.source, reason: withDetail(`"${plugin.filename}" is incompatible with ${shown(file)}, which is present.`, file) }];
  });
  const loadAfters = filesOf('after').flatMap((file): BrokenRule[] => {
    if (file.condition !== undefined) return [unevaluated(plugin, file.condition, 'a load after', `"${file.name}" is not checked`, file.source)];
    const other = order.findIndex((candidate) => fold(candidate.filename) === fold(file.name));
    const target = order[other];
    if (target === undefined || other < index) return [];
    return [{
      rule: 'loadAfter', level: 'warning', plugins: [plugin, target], source: file.source,
      reason: `"${plugin.filename}" loads before ${shown(file)}, and should load after it.`,
    }];
  });
  const messages = matching.flatMap((entry) => entry.msg).flatMap((message): BrokenRule[] => (message.condition === undefined
    ? [{ rule: 'message', level: message.level, plugins: [plugin], source: message.source, reason: message.text }]
    : [unevaluated(plugin, message.condition, 'a message', 'the message is not shown', message.source)]));
  return [...requirements, ...incompatibilities, ...loadAfters, ...messages];
}

/** The rules of LOOT's metadata that `order`, the active plugins in load order, breaks, and the messages and
 *  conditions that apply. A rule whose condition cannot be evaluated is a Warning, never skipped. */
export function judgeLoot(
  order: readonly PluginRef[], entries: readonly LootEntry[], isPresent: (filename: string) => boolean,
): BrokenRule[] {
  return order.flatMap((_, index) => judgePlugin(order, index, entries, isPresent));
}
