import type { BrokenRule, PluginRef } from './judge';
import type { LootEntry, LootFile, LootGroup, RuleSource } from './lootMetadata';

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

const DEFAULT_GROUP = 'default';

// Each group `group` loads after, through the groups between, with the statement of the first step toward it.
function groupsBefore(group: string, afterOf: ReadonlyMap<string, LootGroup['after']>): Map<string, RuleSource> {
  const reached = new Map<string, RuleSource>();
  const queue = (afterOf.get(group) ?? []).map((step) => ({ ...step, first: step.source }));
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    if (reached.has(step.name) || step.name === group) continue;
    reached.set(step.name, step.first);
    queue.push(...(afterOf.get(step.name) ?? []).map((next) => ({ ...next, first: step.first })));
  }
  return reached;
}

// One entry for each plugin that loads before a plugin of a group its own loads after, naming the last, the one a move after keeps the rule for.
function judgeGroups(order: readonly PluginRef[], entries: readonly LootEntry[], groups: readonly LootGroup[]): BrokenRule[] {
  const afterOf = new Map<string, LootGroup['after']>();
  for (const { name, after } of groups) afterOf.set(name, [...afterOf.get(name) ?? [], ...after]);
  const groupOf = (plugin: PluginRef): string =>
    entries.findLast((entry) => entry.group !== undefined && entry.matches(plugin.filename))?.group ?? DEFAULT_GROUP;
  const groupsOfOrder = order.map(groupOf);
  return order.flatMap((plugin, index): BrokenRule[] => {
    const group = groupsOfOrder[index] ?? DEFAULT_GROUP;
    const before = groupsBefore(group, afterOf);
    const last = groupsOfOrder.findLastIndex((other, at) => at > index && before.has(other));
    const target = order[last];
    const earlier = groupsOfOrder[last];
    const source = earlier === undefined ? undefined : before.get(earlier);
    if (target === undefined || earlier === undefined || source === undefined) return [];
    return [{
      rule: 'group', level: 'info', plugins: [plugin, target], source,
      reason: `"${plugin.filename}" is in the group "${group}", which loads after the group "${earlier}", and loads before "${target.filename}", of that group.`,
    }];
  });
}

/** The rules of LOOT's metadata that `order`, the active plugins in load order, breaks, and the messages and
 *  conditions that apply. A rule whose condition cannot be evaluated is a Warning, never skipped. */
export function judgeLoot(
  order: readonly PluginRef[],
  { entries, groups, isPresent }: { entries: readonly LootEntry[]; groups: readonly LootGroup[]; isPresent: (filename: string) => boolean },
): BrokenRule[] {
  return [...order.flatMap((_, index) => judgePlugin(order, index, entries, isPresent)), ...judgeGroups(order, entries, groups)];
}
