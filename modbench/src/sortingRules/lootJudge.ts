import type { BrokenRule, PluginRef } from './judge';
import { distinctReads, evaluateCondition, isFilePresent, isIncompatibilityPresent, readsOf, type ConditionFacts, type FileRead } from './lootConditions';
import { DEFAULT_GROUP, type CleaningData, type LootEntry, type LootFile, type LootGroup, type RuleSource } from './lootMetadata';

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

function unevaluated(plugin: PluginRef, condition: string | undefined, reason: string, what: string, consequence: string, source: RuleSource): BrokenRule {
  return {
    rule: 'condition', level: 'warning', plugins: [plugin], source,
    reason: `"${plugin.filename}": ${condition === undefined ? what : `the condition ${condition} on ${what}`} cannot be evaluated (${reason}), so ${consequence}.`,
  };
}

function itemsCount(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The words LOOT gives a plugin whose checksum its cleaning data lists as dirty.
function cleaningText({ utility, itm, udr, nav, detail }: CleaningData): string {
  const found = [
    ...itm > 0 ? [itemsCount(itm, 'ITM record', 'ITM records')] : [],
    ...udr > 0 ? [itemsCount(udr, 'deleted reference', 'deleted references')] : [],
    ...nav > 0 ? [itemsCount(nav, 'deleted navmesh', 'deleted navmeshes')] : [],
  ];
  const list = found.length <= 1 ? found.join('') : `${found.slice(0, -1).join(', ')} and ${found.at(-1)}`;
  const text = `${utility} found ${found.length === 0 ? 'dirty edits' : list}.`;
  return detail === undefined ? text : `${text} ${detail}`;
}

// What a rule found, or why the facts it needs cannot be told.
type Judged = BrokenRule[] | { cannot: string };

function guarded(
  plugin: PluginRef, facts: ConditionFacts, { condition, source }: { condition?: string; source: RuleSource },
  what: string, consequence: string, broken: () => Judged,
): BrokenRule[] {
  const applied = (): BrokenRule[] => {
    const found = broken();
    return Array.isArray(found) ? found : [unevaluated(plugin, undefined, found.cannot, what, consequence, source)];
  };
  if (condition === undefined) return applied();
  const evaluation = evaluateCondition(condition, facts);
  if (evaluation.kind === 'unevaluable') return [unevaluated(plugin, condition, evaluation.reason, what, consequence, source)];
  return evaluation.value ? applied() : [];
}

function judgePlugin(
  order: readonly PluginRef[], index: number, entries: readonly LootEntry[], facts: ConditionFacts,
): BrokenRule[] {
  const plugin = order[index];
  if (plugin === undefined) return [];
  const matching = entries.filter((entry) => entry.matches(plugin.filename));
  const filesOf = (key: 'req' | 'inc' | 'after'): LootFile[] => distinct(matching.flatMap((entry) => entry[key]));
  const checked = (file: LootFile, what: string, broken: () => Judged): BrokenRule[] =>
    guarded(plugin, facts, file, what, `"${file.name}" is not checked`, broken);
  const requirements = filesOf('req').flatMap((file) => checked(file, 'a requirement', (): Judged => {
    const present = isFilePresent(file.name, facts);
    if (present.kind === 'unevaluable') return { cannot: present.reason };
    if (present.value) return [];
    return [{ rule: 'requirement', level: 'error', plugins: [plugin], source: file.source, reason: withDetail(`"${plugin.filename}" requires ${shown(file)}, which is missing.`, file) }];
  }));
  const incompatibilities = filesOf('inc').flatMap((file) => checked(file, 'an incompatibility', (): Judged => {
    const present = isIncompatibilityPresent(file.name, facts);
    if (present.kind === 'unevaluable') return { cannot: present.reason };
    if (!present.value) return [];
    return [{ rule: 'incompatibility', level: 'error', plugins: [plugin], source: file.source, reason: withDetail(`"${plugin.filename}" is incompatible with ${shown(file)}, which is present.`, file) }];
  }));
  const loadAfters = filesOf('after').flatMap((file) => checked(file, 'a load after', (): Judged => {
    const other = order.findIndex((candidate) => fold(candidate.filename) === fold(file.name));
    const target = order[other];
    if (target === undefined || other < index) return [];
    return [{
      rule: 'loadAfter', level: 'warning', plugins: [plugin, target], source: file.source,
      reason: `"${plugin.filename}" loads before ${shown(file)}, and should load after it.`,
    }];
  }));
  const messages = matching.flatMap((entry) => entry.msg).flatMap((message) =>
    guarded(plugin, facts, message, 'a message', 'the message is not shown', () => [{ rule: 'message', level: message.level, plugins: [plugin], source: message.source, reason: message.text }]));
  return [...requirements, ...incompatibilities, ...loadAfters, ...messages, ...judgeCleaning(plugin, matching, facts)];
}

function judgeCleaning(plugin: PluginRef, matching: readonly LootEntry[], facts: ConditionFacts): BrokenRule[] {
  const listed = matching.flatMap((entry) => entry.dirty);
  const first = listed[0];
  if (first === undefined) return [];
  const checksum = facts.answer({ kind: 'checksum', path: plugin.filename });
  if (checksum.kind === 'unreadable') {
    return [{
      rule: 'condition', level: 'warning', plugins: [plugin], source: first.source,
      reason: `"${plugin.filename}": its checksum cannot be read (${checksum.why}), so its cleaning data is not checked.`,
    }];
  }
  const dirty = listed.filter((data, at) => data.crc === checksum.value && listed.findIndex((other) => other.crc === data.crc && other.utility === data.utility) === at);
  return dirty.flatMap((data) => guarded(plugin, facts, data, 'cleaning data', 'the cleaning data is not checked', () => [
    { rule: 'cleaning', level: 'info', plugins: [plugin], source: data.source, reason: cleaningText(data) },
  ]));
}

/** LOOT applies a group's order within one of these, never across: its sort has a graph for each. */
export type LootPartition = 'masters' | 'blueprintMasters' | 'nonMasters';

/** LOOT's rules and where the files they apply to are present, as the sorting rules judge them. */
export interface LootRules {
  readonly entries: readonly LootEntry[];
  readonly groups: readonly LootGroup[];
  readonly facts: ConditionFacts;
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
  return [...order.flatMap((_, index) => judgePlugin(order, index, rules.entries, rules.facts)), ...judgeGroups(order, rules, partitionOf)];
}

/** The file reads `judgeLoot` needs of `order`: those of every condition on a rule of a plugin in it, and the
 *  checksum of each plugin that has cleaning data. */
export function readsNamed(order: readonly PluginRef[], entries: readonly LootEntry[]): FileRead[] {
  const reads = order.flatMap(({ filename }): FileRead[] => {
    const matching = entries.filter((entry) => entry.matches(filename));
    const guarded = matching.flatMap(({ req, inc, after, msg, dirty }) => [...req, ...inc, ...after, ...msg, ...dirty]);
    return [
      ...guarded.flatMap(({ condition }) => (condition === undefined ? [] : readsOf(condition))),
      ...matching.some(({ dirty }) => dirty.length > 0) ? [{ kind: 'checksum' as const, path: filename }] : [],
    ];
  });
  return distinctReads(reads);
}
