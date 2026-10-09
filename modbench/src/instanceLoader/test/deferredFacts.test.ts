import { describe, it, expect } from 'vitest';
import { deferredFacts, NO_INSTANCE_FACTS, type InstanceFacts } from '../instanceFacts';

describe('deferredFacts', () => {
  it('answers from whichever facts are current at the call, not at construction', () => {
    let current: InstanceFacts = NO_INSTANCE_FACTS;
    const facts = deferredFacts(() => current);
    expect([...facts.trackedMods()]).toEqual([]);

    current = { ...NO_INSTANCE_FACTS, trackedMods: () => new Set(['Mod']) };

    expect([...facts.trackedMods()]).toEqual(['Mod']);
  });
});
