import type { RuleLevel, RuleSource } from './lootMetadata';

interface PluginFacts {
  origin: string;
  masters: readonly string[];
  blueprint: boolean;
  /** The master flag, which a plugin of the `.esm` extension also has. */
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
  rule: 'master' | 'missingMaster' | 'blueprint' | 'masterFlag' | 'requirement' | 'incompatibility' | 'loadAfter' | 'group' | 'message' | 'cleaning' | 'condition';
  level: RuleLevel;
  plugins: PluginRef[];
  reason: string;
  /** Where LOOT's metadata states the rule; the game's rules have none. */
  source?: RuleSource;
}

// ADR-0012: the game compares a plugin's filename without case.
const fold = (filename: string): string => filename.toLowerCase();

const refOf = (filename: string, facts: PluginFacts): PluginRef => ({ origin: facts.origin, filename });

// Master order holds only within one blueprint class; across the two, blueprint last decides.
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
      if (masterFacts === undefined) return [];
      if (masterFacts.blueprint !== facts.blueprint || masterAt < index) return [];
      return [{
        rule: 'master', level: 'error', plugins: [refOf(master, masterFacts), refOf(plugin, facts)],
        reason: `"${master}" is a master of "${plugin}", so it must load before it.`,
      }];
    });
  });
}

// The game loads a blueprint plugin last, and one it loads with no line has no place in plugins.txt to break.
function brokenBlueprints(order: readonly string[], factsOf: PluginFactsOf, loadedWithNoLine: (filename: string) => boolean): BrokenRule[] {
  return order.flatMap((blueprint, index): BrokenRule[] => {
    const facts = factsOf(blueprint);
    if (facts?.blueprint !== true || loadedWithNoLine(blueprint)) return [];
    return order.slice(index + 1).flatMap((other): BrokenRule[] => {
      const otherFacts = factsOf(other);
      if (otherFacts?.blueprint !== false) return [];
      return [{
        rule: 'blueprint', level: 'error', plugins: [refOf(blueprint, facts), refOf(other, otherFacts)],
        reason: `"${blueprint}" is a blueprint plugin, so it must load after "${other}", which is not.`,
      }];
    });
  });
}

function brokenMasterFlags(order: readonly string[], factsOf: PluginFactsOf): BrokenRule[] {
  return order.flatMap((flagged, index): BrokenRule[] => {
    const facts = factsOf(flagged);
    if (facts?.master !== true || facts.blueprint) return [];
    const first = order.slice(0, index).find((other) => factsOf(other)?.master === false);
    const firstFacts = first === undefined ? undefined : factsOf(first);
    if (first === undefined || firstFacts === undefined) return [];
    return [{
      rule: 'masterFlag', level: 'warning', plugins: [refOf(flagged, facts), refOf(first, firstFacts)],
      reason: `"${flagged}" has the master flag, so the game loads it before "${first}", which has not.`,
    }];
  });
}

/** The game's sorting rules `order` breaks, `plugins.txt`'s names losing end first. */
export function judge(order: readonly string[], factsOf: PluginFactsOf, loadedWithNoLine: (filename: string) => boolean = () => false): BrokenRule[] {
  return [...brokenMasters(order, factsOf), ...brokenBlueprints(order, factsOf, loadedWithNoLine), ...brokenMasterFlags(order, factsOf)];
}
