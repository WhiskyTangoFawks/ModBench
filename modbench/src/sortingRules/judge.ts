import type { SuggestedMove } from './suggestedMove';
import type { RuleLevel, RuleSource } from './lootMetadata';

interface PluginFacts {
  origin: string;
  masters: readonly string[];
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

interface Reading {
  factsOf: PluginFactsOf;
  /** Whether the game loads it: a line that is not active is judged where it would load, and moves no other plugin. */
  loads: (filename: string) => boolean;
}

// libloadorder's read of plugins.txt (load_order/mutable.rs). A plugin mEdit has not read loads as one that is no master.
function gameOrder(loadedWithNoLine: readonly string[], lines: readonly string[], { factsOf, loads }: Reading): { order: string[]; hoistedBy: Map<string, string> } {
  const order = [...loadedWithNoLine.filter((name) => !isBlueprintMaster(factsOf(name))), ...loadedWithNoLine.filter((name) => isBlueprintMaster(factsOf(name)))];
  const hoistedBy = new Map<string, string>();
  for (const line of lines) {
    const canHoist = isBlueprintMaster(factsOf(line)) ? isBlueprintMaster : isMasterFile;
    const at = order.findIndex((other) => loads(other) && canHoist(factsOf(other)) && lists(factsOf(other), line));
    const by = order[at];
    if (by !== undefined) hoistedBy.set(line, by);
    order.splice(by === undefined ? insertionIndex(order, line, factsOf) : at, 0, line);
  }
  for (const [hoisted, by] of hoistMasters(order, { factsOf, loads })) hoistedBy.set(hoisted, by);
  return { order, hoistedBy };
}

function insertionIndex(order: readonly string[], plugin: string, factsOf: PluginFactsOf): number {
  const facts = factsOf(plugin);
  const first = (where: (other: PluginFacts | undefined) => boolean): number => {
    const index = order.findIndex((other) => where(factsOf(other)));
    return index === -1 ? order.length : index;
  };
  if (isBlueprintMaster(facts)) return order.length;
  if (isMasterFile(facts)) return first((other) => !isMasterFile(other) || isBlueprintMaster(other));
  return first(isBlueprintMaster);
}

function hoistMasters(order: string[], { factsOf, loads }: Reading): [hoisted: string, by: string][] {
  const moves = new Map<number, { to: number; by: string }>();
  order.forEach((plugin, index) => {
    const facts = factsOf(plugin);
    if (!loads(plugin) || !isMasterFile(facts)) return;
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

const NOT_LISTED_THERE = 'not where plugins.txt lists it.';

// A plugin that is not a blueprint master passes a blueprint master only as that blueprint master moves to load last.
function brokenGameMoves(
  loadedWithNoLine: readonly string[], lines: readonly string[], { order, hoistedBy }: ReturnType<typeof gameOrder>, { factsOf, loads }: Reading,
): BrokenRule[] {
  const listed = [...loadedWithNoLine, ...lines];
  const loadedAt = new Map(order.map((name, index) => [name, index] as const));
  const loadsBefore = (a: string, b: string): boolean => (loadedAt.get(a) ?? -1) < (loadedAt.get(b) ?? -1);
  const passable = (other: string): boolean => loads(other) && factsOf(other) !== undefined;
  return lines.flatMap((plugin, index): BrokenRule[] => {
    const facts = factsOf(plugin);
    if (facts === undefined) return [];
    const at = loadedWithNoLine.length + index;
    const blueprint = isBlueprintMaster(facts);
    const anchorBefore = listed.slice(0, at)
      .find((other) => passable(other) && loadsBefore(plugin, other) && (blueprint || !isBlueprintMaster(factsOf(other))));
    const anchorAfter = blueprint ? listed.slice(at + 1).findLast((other) => passable(other) && loadsBefore(other, plugin) && !isBlueprintMaster(factsOf(other))) : undefined;
    const anchor = anchorBefore ?? anchorAfter;
    const anchorFacts = anchor === undefined ? undefined : factsOf(anchor);
    if (anchor === undefined || anchorFacts === undefined) return [];
    const by = hoistedBy.get(plugin);
    const reason = anchorBefore === undefined ? `"${plugin}" is a blueprint plugin, so the game loads it after "${anchor}", ${NOT_LISTED_THERE}`
      : by === undefined ? `"${plugin}" loads as a master, by its master flag or its extension, so the game loads it before "${anchor}", ${NOT_LISTED_THERE}`
        : `"${plugin}" is a master of "${by}", which loads as a master, so the game loads it before "${anchor}", ${NOT_LISTED_THERE}`;
    return [{
      rule: 'gameMoves', level: 'warning', plugins: [refOf(plugin, facts)],
      placement: { side: anchorBefore === undefined ? 'after' : 'before', anchor: refOf(anchor, anchorFacts) }, reason,
    }];
  });
}

// A plugin that is not a blueprint master holds no master rule against a blueprint master, which the game loads last.
function brokenMasters(order: readonly string[], { factsOf, loads }: Reading): BrokenRule[] {
  const at = new Map(order.flatMap((filename, index) => (loads(filename) ? [[fold(filename), index] as const] : [])));
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
      // Were it active, the game would hoist its masters above a master that is not.
      if (!loads(plugin) && isMasterFile(facts)) return [];
      return [{
        rule: 'master', level: 'error', plugins: [refOf(master, masterFacts), refOf(plugin, facts)],
        reason: `"${master}" is a master of "${plugin}", so it must load before it.`,
      }];
    });
  });
}

/** The order the game loads the plugins it loads with no line, then plugins.txt's `lines`, in, and the game's sorting rules
 *  that order breaks. The game loads a line only while it is active. */
export function judge(
  loadedWithNoLine: readonly string[], lines: readonly string[], factsOf: PluginFactsOf, isActive: (filename: string) => boolean = () => true,
): { order: string[]; broken: BrokenRule[] } {
  const noLine = new Set(loadedWithNoLine);
  const reading: Reading = { factsOf, loads: (filename) => noLine.has(filename) || isActive(filename) };
  const game = gameOrder(loadedWithNoLine, lines, reading);
  return { order: game.order, broken: [...brokenMasters(game.order, reading), ...brokenGameMoves(loadedWithNoLine, lines, game, reading)] };
}
