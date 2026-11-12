import type { SuggestedMove } from './suggestedMove';
import type { RuleLevel, RuleSource } from './lootMetadata';

interface PluginFacts {
  origin: string;
  masters: readonly string[];
  /** Whether it is a blueprint plugin, in a release that loads a blueprint master after every plugin that is not one. */
  blueprint: boolean;
  /** Whether the game loads it as a master, by its master flag or its extension. */
  master: boolean;
}

/** `undefined` while mEdit cannot say, and a rule that needs the answer is not judged. */
export type PluginFactsOf = (filename: string) => PluginFacts | undefined;

export interface PluginRef {
  origin: string;
  filename: string;
}

/** A plugin as the rest of Modbench addresses it. */
export const addressOfRef = ({ origin, filename }: PluginRef): { name: string; origin: string } => ({ name: filename, origin });

export interface BrokenRule {
  rule: 'master' | 'missingMaster' | 'gameMoves' | 'requirement' | 'incompatibility' | 'loadAfter' | 'group' | 'message' | 'cleaning' | 'condition';
  level: RuleLevel;
  plugins: PluginRef[];
  reason: string;
  /** Where LOOT's metadata states the rule; the game's rules have none. */
  source?: RuleSource;
  /** Where the rule's one plugin goes to keep it, when the rule names no plugin to go beside. */
  placement?: Omit<SuggestedMove, 'mover'>;
}

// ADR-0012: the game compares a plugin's filename without case.
const fold = (filename: string): string => filename.toLowerCase();

const refOf = (filename: string, facts: PluginFacts): PluginRef => ({ origin: facts.origin, filename });

const isMasterFile = (facts: PluginFacts | undefined): boolean => facts?.master === true;
const isBlueprintMaster = (facts: PluginFacts | undefined): boolean => facts?.master === true && facts.blueprint;

const lists = (facts: PluginFacts | undefined, master: string): boolean => facts?.masters.some((name) => fold(name) === fold(master)) === true;

// Why the game loads a line away from where plugins.txt lists it.
type Move = { kind: 'early' } | { kind: 'hoisted'; by: string } | { kind: 'blueprint' };

// libloadorder's read of plugins.txt: each line is inserted where the game loads it among those before it, then masters are
// hoisted. A plugin mEdit has not read loads as one that is no master.
function gameOrder(loadedWithNoLine: readonly string[], lines: readonly string[], factsOf: PluginFactsOf): { order: string[]; moves: Map<string, Move> } {
  const order = [...loadedWithNoLine.filter((name) => !isBlueprintMaster(factsOf(name))), ...loadedWithNoLine.filter((name) => isBlueprintMaster(factsOf(name)))];
  const moves = new Map<string, Move>();
  for (const line of lines) {
    const facts = factsOf(line);
    const { index, hoistedBy } = insertion(order, line, factsOf);
    for (const jumped of order.slice(index)) {
      if (isBlueprintMaster(factsOf(jumped)) && !isBlueprintMaster(facts)) moves.set(jumped, { kind: 'blueprint' });
      else moves.set(line, hoistedBy === undefined ? { kind: 'early' } : { kind: 'hoisted', by: hoistedBy });
    }
    order.splice(index, 0, line);
  }
  for (const [hoisted, by] of hoistMasters(order, factsOf)) moves.set(hoisted, { kind: 'hoisted', by });
  for (const name of loadedWithNoLine) moves.delete(name);
  return { order, moves };
}

function insertion(order: readonly string[], plugin: string, factsOf: PluginFactsOf): { index: number; hoistedBy?: string } {
  const facts = factsOf(plugin);
  const canHoist = isBlueprintMaster(facts) ? isBlueprintMaster : isMasterFile;
  const hoisting = order.findIndex((other) => canHoist(factsOf(other)) && lists(factsOf(other), plugin));
  if (hoisting !== -1) return { index: hoisting, hoistedBy: order[hoisting] };
  const first = (where: (other: PluginFacts | undefined) => boolean): { index: number } => {
    const index = order.findIndex((other) => where(factsOf(other)));
    return { index: index === -1 ? order.length : index };
  };
  if (isBlueprintMaster(facts)) return { index: order.length };
  if (isMasterFile(facts)) return first((other) => !isMasterFile(other) || isBlueprintMaster(other));
  return first(isBlueprintMaster);
}

// libloadorder's hoist_masters: a master listed after a master that lists it loads directly before the first such.
function hoistMasters(order: string[], factsOf: PluginFactsOf): [hoisted: string, by: string][] {
  const moves = new Map<number, { to: number; by: string }>();
  order.forEach((plugin, index) => {
    const facts = factsOf(plugin);
    if (!isMasterFile(facts)) return;
    for (const master of facts?.masters ?? []) {
      const at = order.findIndex((other) => fold(other) === fold(master) && (isBlueprintMaster(facts) || !isBlueprintMaster(factsOf(other))));
      if (at > index && !moves.has(at)) moves.set(at, { to: index, by: plugin });
    }
  });
  const pending = [...moves].sort(([a], [b]) => a - b).map(([from, move]) => ({ from, ...move }));
  return pending.flatMap(({ from, to, by }, i): [string, string][] => {
    const [plugin] = order.splice(from, 1);
    if (plugin === undefined) return [];
    order.splice(to, 0, plugin);
    for (const later of pending.slice(i + 1)) if (later.to < from && later.to > to) later.to++;
    return [[plugin, by]];
  });
}

function reasonOf(plugin: string, move: Move, anchor: string): string {
  const where = 'not where plugins.txt lists it.';
  switch (move.kind) {
    case 'early': return `"${plugin}" loads as a master, by its master flag or its extension, so the game loads it before "${anchor}", ${where}`;
    case 'hoisted': return `"${plugin}" is a master of "${move.by}", which loads as a master, so the game loads it before "${anchor}", ${where}`;
    case 'blueprint': return `"${plugin}" is a blueprint plugin, so the game loads it after "${anchor}", ${where}`;
  }
}

// On the plugin the game moves, beside the farthest plugin it passes that mEdit has read.
function movedPlugins(listed: readonly string[], order: readonly string[], moves: ReadonlyMap<string, Move>, factsOf: PluginFactsOf): BrokenRule[] {
  const loadedAt = new Map(order.map((name, index) => [name, index] as const));
  const loadsBefore = (a: string, b: string): boolean => (loadedAt.get(a) ?? -1) < (loadedAt.get(b) ?? -1);
  return listed.flatMap((plugin, at): BrokenRule[] => {
    const move = moves.get(plugin);
    const facts = factsOf(plugin);
    if (move === undefined || facts === undefined) return [];
    const later = move.kind === 'blueprint';
    const passed = later
      ? listed.slice(at + 1).filter((other) => loadsBefore(other, plugin))
      : listed.slice(0, at).filter((other) => loadsBefore(plugin, other));
    const read = passed.filter((other) => factsOf(other) !== undefined);
    const anchor = later ? read.at(-1) : read[0];
    const anchorFacts = anchor === undefined ? undefined : factsOf(anchor);
    if (anchor === undefined || anchorFacts === undefined) return [];
    return [{
      rule: 'gameMoves', level: 'warning', plugins: [refOf(plugin, facts)], placement: { side: later ? 'after' : 'before', anchor: refOf(anchor, anchorFacts) },
      reason: reasonOf(plugin, move, anchor),
    }];
  });
}

// A plugin that is not a blueprint master holds no master rule against a blueprint master, which the game loads last.
function brokenMasters(order: readonly string[], factsOf: PluginFactsOf): BrokenRule[] {
  const at = new Map(order.map((filename, index) => [fold(filename), index] as const));
  return order.flatMap((plugin, index): BrokenRule[] => {
    const facts = factsOf(plugin);
    if (facts === undefined) return [];
    return facts.masters.flatMap((masterName): BrokenRule[] => {
      const masterAt = at.get(fold(masterName));
      const master = masterAt === undefined ? undefined : order[masterAt];
      if (master === undefined || masterAt === undefined) {
        return [{
          rule: 'missingMaster', level: 'error', plugins: [refOf(plugin, facts)],
          reason: `"${masterName}" is a master of "${plugin}", and is missing or not active.`,
        }];
      }
      const masterFacts = factsOf(master);
      if (masterFacts === undefined || masterAt < index) return [];
      if (isBlueprintMaster(masterFacts) && !isBlueprintMaster(facts)) return [];
      return [{
        rule: 'master', level: 'error', plugins: [refOf(master, masterFacts), refOf(plugin, facts)],
        reason: `"${master}" is a master of "${plugin}", so it must load before it.`,
      }];
    });
  });
}

/** The order the game loads the plugins it loads with no line, then plugins.txt's `lines`, in, and the game's sorting rules
 *  that order breaks. */
export function judge(loadedWithNoLine: readonly string[], lines: readonly string[], factsOf: PluginFactsOf): { order: string[]; broken: BrokenRule[] } {
  const { order, moves } = gameOrder(loadedWithNoLine, lines, factsOf);
  return { order, broken: [...brokenMasters(order, factsOf), ...movedPlugins([...loadedWithNoLine, ...lines], order, moves, factsOf)] };
}
