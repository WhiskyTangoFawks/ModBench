interface PluginFacts {
  origin: string;
  masters: readonly string[];
  blueprint: boolean;
}

/** `undefined` while mEdit cannot say, and a rule that needs the answer is not judged. */
export type PluginFactsOf = (filename: string) => PluginFacts | undefined;

interface PluginRef {
  origin: string;
  filename: string;
}

export interface BrokenRule {
  rule: 'master' | 'blueprint';
  level: 'error';
  plugins: [PluginRef, PluginRef];
  reason: string;
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
      const masterFacts = master === undefined ? undefined : factsOf(master);
      if (master === undefined || masterAt === undefined || masterFacts === undefined) return [];
      if (masterFacts.blueprint !== facts.blueprint || masterAt < index) return [];
      return [{
        rule: 'master', level: 'error', plugins: [refOf(master, masterFacts), refOf(plugin, facts)],
        reason: `"${master}" is a master of "${plugin}", so it must load before it.`,
      }];
    });
  });
}

function brokenBlueprints(order: readonly string[], factsOf: PluginFactsOf): BrokenRule[] {
  return order.flatMap((blueprint, index): BrokenRule[] => {
    const facts = factsOf(blueprint);
    if (facts?.blueprint !== true) return [];
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

/** The game's sorting rules `order` breaks, `plugins.txt`'s names losing end first. */
export function judge(order: readonly string[], factsOf: PluginFactsOf): BrokenRule[] {
  return [...brokenMasters(order, factsOf), ...brokenBlueprints(order, factsOf)];
}
