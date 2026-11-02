import type { BrokenRule, PluginRef } from './judge';
import { DEFAULT_GROUP, type LootEntry, type LootFile, type LootGroup, type RuleSource } from './lootMetadata';

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

/** LOOT applies a group's order within one of these, never across: its sort has a graph for each. */
export type LootPartition = 'masters' | 'blueprintMasters' | 'nonMasters';

/** LOOT's rules and where the files they apply to are present, as the sorting rules judge them. */
export interface LootRules {
  readonly entries: readonly LootEntry[];
  readonly groups: readonly LootGroup[];
  readonly isPresent: (filename: string) => boolean;
}

interface Placed {
  plugin: PluginRef;
  group: string;
  partition: LootPartition;
}

function groupsBefore(group: string, afterOf: ReadonlyMap<string, LootGroup['after']>): Map<string, RuleSource> {
  const reached = new Map<string, RuleSource>();
  const queue = (afterOf.get(group) ?? []).map((step) => ({ ...step, stated: step.source }));
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    if (reached.has(step.name) || step.name === group) continue;
    reached.set(step.name, step.stated);
    const stated = step.stated.file === 'userlist' ? step.stated : undefined;
    queue.push(...(afterOf.get(step.name) ?? []).map((next) => ({ ...next, stated: stated ?? (next.source.file === 'userlist' ? next.source : step.stated) })));
  }
  return reached;
}

function groupOf(plugin: PluginRef, entries: readonly LootEntry[]): string {
  const stating = entries.filter((entry) => entry.group !== undefined && entry.matches(plugin.filename));
  const chosen = stating.find((entry) => entry.group?.source.file === 'userlist' && entry.exact)
    ?? stating.find((entry) => entry.group?.source.file === 'userlist')
    ?? stating.find((entry) => entry.exact)
    ?? stating[0];
  return chosen?.group?.name ?? DEFAULT_GROUP;
}

function judgeGroups(
  order: readonly PluginRef[], { entries, groups }: LootRules, partitionOf: (filename: string) => LootPartition | undefined,
): BrokenRule[] {
  const afterOf = new Map(groups.map(({ name, after }) => [name, after]));
  const beforeOf = new Map<string, Map<string, RuleSource>>();
  const before = (group: string): Map<string, RuleSource> => {
    const known = beforeOf.get(group) ?? groupsBefore(group, afterOf);
    beforeOf.set(group, known);
    return known;
  };
  const placed = order.flatMap((plugin): Placed[] => {
    const partition = partitionOf(plugin.filename);
    return partition === undefined ? [] : [{ plugin, group: groupOf(plugin, entries), partition }];
  });
  return placed.flatMap((early, index): BrokenRule[] => {
    const groupsAfter = before(early.group);
    const last = placed.slice(index + 1).findLast((other) => other.partition === early.partition && groupsAfter.has(other.group));
    const source = last === undefined ? undefined : groupsAfter.get(last.group);
    if (last === undefined || source === undefined) return [];
    return [{
      rule: 'group', level: 'info', plugins: [early.plugin, last.plugin], source,
      reason: `"${early.plugin.filename}" is in the group "${early.group}", which loads after the group "${last.group}", and loads before "${last.plugin.filename}", of that group.`,
    }];
  });
}

/** The rules of LOOT's metadata that `order`, the active plugins in load order, breaks, and the messages that apply.
 *  A condition that cannot be evaluated is a Warning. `partitionOf` is `undefined` while a plugin's master flag is unread. */
export function judgeLoot(
  order: readonly PluginRef[], rules: LootRules, partitionOf: (filename: string) => LootPartition | undefined,
): BrokenRule[] {
  return [...order.flatMap((_, index) => judgePlugin(order, index, rules.entries, rules.isPresent)), ...judgeGroups(order, rules, partitionOf)];
}
