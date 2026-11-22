import type { BrokenRule, PluginRef } from './judge';
import { distinctReads, evaluateCondition, isFilePresent, isIncompatibilityPresent, isOneOf, pathsOf, readsOf, type ConditionFacts, type FileRead } from './lootConditions';
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
  order: readonly PluginRef[], index: number, entries: readonly LootEntry[], facts: ConditionFacts, loadedWithNoLine: LoadedWithNoLine,
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
    if (target === undefined || other < index || (loadedWithNoLine(plugin.filename) && loadedWithNoLine(target.filename))) return [];
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

type LoadedWithNoLine = (filename: string) => boolean;

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
  order: readonly PluginRef[], { entries, groups }: LootRules, partitionOf: (filename: string) => LootPartition | undefined, loadedWithNoLine: LoadedWithNoLine,
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
  const crossings: Crossing[] = placed.flatMap((early, at) => placed.flatMap((late, later): Crossing[] => {
    const source = later > at && early.partition === late.partition ? before(early.group).get(late.group) : undefined;
    const held = loadedWithNoLine(early.plugin.filename) && loadedWithNoLine(late.plugin.filename);
    return source === undefined || held ? [] : [{ early: at, late: later, source }];
  }));
  return placeOutOfGroup(crossings, placed.length).map(({ index, crossed }) => brokenGroup(placed, index, crossed));
}

interface Crossing {
  early: number;
  late: number;
  source: RuleSource;
  dropped?: true;
}

function placeOutOfGroup(crossings: readonly Crossing[], plugins: number): { index: number; crossed: Crossing[] }[] {
  const counts = new Array<number>(plugins).fill(0);
  const touching = Array.from({ length: plugins }, (): Crossing[] => []);
  for (const crossing of crossings) {
    for (const index of [crossing.early, crossing.late]) {
      counts[index] = (counts[index] ?? 0) + 1;
      touching[index]?.push(crossing);
    }
  }
  const picked: { index: number; crossed: Crossing[] }[] = [];
  for (;;) {
    const index = counts.reduce((best, count, at) => (count > 0 && count >= (counts[best] ?? 0) ? at : best), -1);
    if (index < 0) return picked.sort((a, b) => a.index - b.index);
    const crossed = (touching[index] ?? []).filter(({ dropped }) => !dropped);
    for (const crossing of crossed) {
      crossing.dropped = true;
      const other = crossing.early === index ? crossing.late : crossing.early;
      counts[other] = (counts[other] ?? 0) - 1;
    }
    counts[index] = 0;
    picked.push({ index, crossed });
  }
}

const plural = (count: number): string => `${count} plugin${count === 1 ? '' : 's'}`;

function brokenGroup(placed: readonly Placed[], index: number, crossed: readonly Crossing[]): BrokenRule {
  const mover = placed[index];
  const passed = crossed.filter(({ early }) => early === index).sort((a, b) => b.late - a.late);
  const passing = crossed.filter(({ late }) => late === index).sort((a, b) => a.early - b.early);
  const anchor = placed[passed[0]?.late ?? passing[0]?.early ?? -1];
  const first = passed[0] ?? passing[0];
  if (mover === undefined || anchor === undefined || first === undefined) throw new Error('A group crossing names a plugin outside the order.');
  const clauses = (side: 'after' | 'before', others: readonly Crossing[], at: (crossing: Crossing) => number): string[] => {
    const counts = new Map<string, number>();
    for (const crossing of others) {
      const group = placed[at(crossing)]?.group ?? '';
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts].map(([group, count]) => `which loads ${side} the group "${group}", and loads ${side === 'after' ? 'before' : 'after'} ${plural(count)} of that group`);
  };
  const stated = [...clauses('after', passed, ({ late }) => late), ...clauses('before', passing, ({ early }) => early)];
  return {
    rule: 'group', level: 'info', plugins: [mover.plugin], source: crossed.find(({ source }) => source.file === 'userlist')?.source ?? first.source,
    placement: { side: passed.length > 0 ? 'after' : 'before', anchor: anchor.plugin },
    reason: `"${mover.plugin.filename}" is in the group "${mover.group}", ${stated.join(', and ')}.`,
  };
}

/** The rules of LOOT's metadata that `order`, the active plugins in load order, breaks, and the messages that apply.
 *  An unevaluable condition is a Warning. `partitionOf` is `undefined` while a master flag is unread. */
export function judgeLoot(
  order: readonly PluginRef[], rules: LootRules, partitionOf: (filename: string) => LootPartition | undefined,
  loadedWithNoLine: LoadedWithNoLine = () => false,
): BrokenRule[] {
  return [...order.flatMap((_, index) => judgePlugin(order, index, rules.entries, rules.facts, loadedWithNoLine)), ...judgeGroups(order, rules, partitionOf, loadedWithNoLine)];
}

// The entries a plugin matches, and each of their parts a condition may guard.
function entriesOf(filename: string, entries: readonly LootEntry[]): { matching: LootEntry[]; guarded: { condition?: string }[] } {
  const matching = entries.filter((entry) => entry.matches(filename));
  return { matching, guarded: matching.flatMap(({ req, inc, after, msg, dirty }) => [...req, ...inc, ...after, ...msg, ...dirty]) };
}

/** Whether judging `order` against `entries` reads a file, relative to the Data folder: its presence, bytes or version. */
export function filesJudged(order: readonly PluginRef[], entries: readonly LootEntry[]): (path: string) => boolean {
  return isOneOf(order.flatMap(({ filename }) => {
    const { matching, guarded } = entriesOf(filename, entries);
    return [
      ...matching.flatMap(({ req, inc }) => [...req, ...inc].map(({ name }) => name)),
      ...guarded.flatMap(({ condition }) => (condition === undefined ? [] : pathsOf(condition))),
      ...matching.some(({ dirty }) => dirty.length > 0) ? [filename] : [],
    ];
  }));
}

/** The file reads `judgeLoot` needs of `order`: those of every condition on a rule of a plugin in it, and the
 *  checksum of each plugin that has cleaning data. */
export function readsNamed(order: readonly PluginRef[], entries: readonly LootEntry[]): FileRead[] {
  const reads = order.flatMap(({ filename }): FileRead[] => {
    const { matching, guarded } = entriesOf(filename, entries);
    return [
      ...guarded.flatMap(({ condition }) => (condition === undefined ? [] : readsOf(condition))),
      ...matching.some(({ dirty }) => dirty.length > 0) ? [{ kind: 'checksum' as const, path: filename }] : [],
    ];
  });
  return distinctReads(reads);
}
