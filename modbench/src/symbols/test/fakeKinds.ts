import type { SymbolKind, SymbolKinds } from '../symbolKind';

/** A kind that names nothing and answers nothing but what `over` answers. */
export function fakeKind<Symbol>(over: Partial<SymbolKind<Symbol>> = {}): SymbolKind<Symbol> {
  return {
    nameAt: () => Promise.resolve(undefined),
    definitionOf: () => Promise.resolve({ none: 'Not defined here.' }),
    referencesTo: () => Promise.resolve({ locations: [], unread: [] }),
    tooltipOf: () => Promise.resolve([]),
    completionsAt: () => Promise.resolve(undefined),
    symbolsFor: () => Promise.resolve([]),
    ...over,
  };
}

export const fakeKinds = (over: Partial<SymbolKinds> = {}): SymbolKinds => ({
  plugin: fakeKind(), record: fakeKind(), entry: fakeKind(), script: fakeKind(), file: fakeKind(), ...over,
});
