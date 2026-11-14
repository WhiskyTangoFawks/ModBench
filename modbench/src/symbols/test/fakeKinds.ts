import type { SymbolKind, SymbolKinds, SymbolSearch } from '../symbolKind';

/** Go to Symbol in Workspace's search, which nothing cancels. */
export const SEARCH: SymbolSearch = { gesture: 'Go to Symbol in Workspace', cancelled: () => false };

/** Completion's search, which nothing cancels. */
export const COMPLETION: SymbolSearch = { gesture: 'Completion', cancelled: () => false };

/** A kind that names nothing and answers nothing but what `over` answers. */
export function fakeKind<Symbol>(over: Partial<SymbolKind<Symbol>> = {}): SymbolKind<Symbol> {
  return {
    nameAt: () => Promise.resolve(undefined),
    definitionOf: () => Promise.resolve({ none: 'Not defined here.' }),
    referencesTo: () => Promise.resolve({ locations: [], unread: [] }),
    referencedBy: () => Promise.resolve(),
    tooltipOf: () => Promise.resolve([]),
    completionsAt: () => Promise.resolve(undefined),
    symbolsFor: () => Promise.resolve([]),
    ...over,
  };
}

export const fakeKinds = (over: Partial<SymbolKinds> = {}): SymbolKinds => ({
  plugin: fakeKind(), record: fakeKind(), entry: fakeKind(), script: fakeKind(), file: fakeKind(), ...over,
});
