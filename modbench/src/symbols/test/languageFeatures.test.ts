import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { SymbolKind } from './iconsMock';

interface FakeDocument {
  readonly uri: unknown;
  getText(): string;
  offsetAt(position: FakePosition): number;
  positionAt(offset: number): FakePosition;
}
interface FakePosition { readonly line: number; readonly character: number }
interface Captured {
  hover?: { provideHover(document: FakeDocument, position: FakePosition): Promise<{ contents: unknown } | undefined> };
  completion?: { provideCompletionItems(document: FakeDocument, position: FakePosition): Promise<unknown> };
  definition?: { provideDefinition(document: FakeDocument, position: FakePosition): Promise<unknown> };
  references?: { provideReferences(document: FakeDocument, position: FakePosition): Promise<unknown> };
  workspaceSymbols?: {
    provideWorkspaceSymbols(query: string): Promise<{ name: string; location: unknown }[]>;
    resolveWorkspaceSymbol(symbol: { name: string; location: unknown }): Promise<{ location: unknown }>;
  };
}

const captured = vi.hoisted((): Captured => ({}));
vi.mock('vscode', () => {
  const dispose = { dispose: () => undefined };
  return {
    Uri, SymbolKind, TreeItem, TreeItemCollapsibleState,
    Position: class { constructor(readonly line: number, readonly character: number) {} },
    Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
    Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
    Hover: class { constructor(readonly contents: unknown, readonly range: unknown) {} },
    MarkdownString: class { constructor(readonly value: string) {} },
    CompletionItem: class { range: unknown; insertText: unknown; filterText: unknown; constructor(readonly label: unknown, readonly kind: unknown) {} },
    CompletionList: class { constructor(readonly items: unknown[], readonly isIncomplete: boolean) {} },
    SymbolInformation: class { constructor(readonly name: string, readonly kind: unknown, readonly containerName: string, public location: unknown) {} },
    Disposable: { from: () => dispose },
    languages: {
      registerHoverProvider: (_on: unknown, provider: Captured['hover']) => { captured.hover = provider; return dispose; },
      registerCompletionItemProvider: (_on: unknown, provider: Captured['completion']) => { captured.completion = provider; return dispose; },
      registerDefinitionProvider: (_on: unknown, provider: Captured['definition']) => { captured.definition = provider; return dispose; },
      registerReferenceProvider: (_on: unknown, provider: Captured['references']) => { captured.references = provider; return dispose; },
      registerWorkspaceSymbolProvider: (provider: Captured['workspaceSymbols']) => { captured.workspaceSymbols = provider; return dispose; },
      registerRenameProvider: () => dispose,
    },
  };
});

import * as vscode from 'vscode';
import { registerLanguageFeatures } from '../languageFeatures';
import type { CopyAt } from '../../instanceLoader/fileConflictIndex';
import type { Definition, References, SymbolKind as Kind, SymbolKinds } from '../symbolKind';
import { fakeKind, fakeKinds } from './fakeKinds';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';

const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Npc.json';
const document: FakeDocument = {
  uri: Uri.file(FILE), getText: () => '{ "Model": "Actors\\\\Npc.nif" }',
  offsetAt: ({ character }) => character, positionAt: (offset) => ({ line: 0, character: offset }),
};
const AT = { line: 0, character: 14 };
const SPAN = { start: 12, end: 26, spelled: 'Actors\\Npc.nif' };
const NAMED = { ...SPAN, symbol: { kind: 'file' as const, path: 'meshes/actors/npc.nif' } };
const ELSEWHERE = new vscode.Location(vscode.Uri.file('/elsewhere.json'), new vscode.Position(0, 0));

type Answers = Pick<Partial<Kind<never>>, 'definitionOf' | 'referencesTo' | 'hoverOf'>;

function claimedBy(claiming: keyof SymbolKinds, answers: Answers = {}): SymbolKinds {
  switch (claiming) {
    case 'plugin': return fakeKinds({ plugin: fakeKind({ ...answers, nameAt: () => Promise.resolve({ ...SPAN, symbol: { kind: 'plugin' as const, name: 'A.esp' } }) }) });
    case 'entry': return fakeKinds({ entry: fakeKind({ ...answers, nameAt: () => Promise.resolve({ ...SPAN, symbol: { kind: 'mod' as const, name: 'A' } }) }) });
    case 'script': return fakeKinds({ script: fakeKind({ ...answers, nameAt: () => Promise.resolve({ ...SPAN, symbol: { kind: 'script' as const, name: 'A' } }) }) });
    case 'file': return fakeKinds({ file: fakeKind({ ...answers, nameAt: () => Promise.resolve(NAMED) }) });
    case 'record': return fakeKinds({ record: fakeKind({ ...answers, nameAt: () => Promise.resolve({ ...SPAN, symbol: { kind: 'record' as const, formKey: '000801:A.esp' } }) }) });
  }
}

function features(kinds: SymbolKinds) {
  const reporter = recordingReporter();
  const reveal = vi.fn((_copy: CopyAt) => Promise.resolve());
  registerLanguageFeatures({ kinds, reporter, reveal, rename: { prepare: () => Promise.reject(new Error('Not renamed here.')), rename: () => Promise.resolve() } });
  return {
    reporter, reveal,
    definition: () => present(captured.definition, 'definition').provideDefinition(document, AT),
    references: () => present(captured.references, 'references').provideReferences(document, AT),
    hover: () => present(captured.hover, 'hover').provideHover(document, AT),
    completion: () => present(captured.completion, 'completion').provideCompletionItems(document, AT),
    workspaceSymbols: (query: string) => present(captured.workspaceSymbols, 'workspace symbols').provideWorkspaceSymbols(query),
    resolve: (symbol: { name: string; location: unknown }) => present(captured.workspaceSymbols, 'workspace symbols').resolveWorkspaceSymbol(symbol),
  };
}

const defining = (definition: Definition) => features(claimedBy('file', { definitionOf: () => Promise.resolve(definition) }));

describe('each language feature asks the symbol under the place, of whatever kind (symbols.md, The features)', () => {
  const ANSWERED = { locations: [ELSEWHERE], unread: [] };

  it.each(['plugin', 'entry', 'script', 'file', 'record'] as const)('Go to Definition, Find All References and hover each ask the %s kind that names the place', async (claiming) => {
    const asked = features(claimedBy(claiming, {
      definitionOf: () => Promise.resolve({ at: ELSEWHERE }), referencesTo: () => Promise.resolve(ANSWERED), hoverOf: () => Promise.resolve([claiming]),
    }));

    expect([await asked.definition(), await asked.references(), (await asked.hover())?.contents]).toEqual([ELSEWHERE, [ELSEWHERE], { value: claiming }]);
  });

  it('asks a plugin\'s name inside a FormKey of the plugin, not the record', async () => {
    const asked = features({
      ...claimedBy('plugin', { hoverOf: () => Promise.resolve(['the plugin']) }),
      record: claimedBy('record', { hoverOf: () => Promise.resolve(['the record']) }).record,
    });

    expect((await asked.hover())?.contents).toEqual({ value: 'the plugin' });
  });

  it('answers nothing where no kind names the place', async () => {
    const asked = features(fakeKinds());

    expect([await asked.definition(), await asked.references(), await asked.hover(), await asked.completion()]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('Go to Definition presents the symbol\'s definition (symbols.md, The symbols)', () => {
  const OWN = { uri: document.uri, range: { start: { line: 0, character: NAMED.start }, end: { line: 0, character: NAMED.end } } };

  it('opens a place there', async () => {
    expect(await defining({ at: ELSEWHERE }).definition()).toBe(ELSEWHERE);
  });

  it('opens a file at its start', async () => {
    expect(await defining({ file: '/scripts/Quest.psc' }).definition()).toEqual({ uri: Uri.file('/scripts/Quest.psc'), range: { line: 0, character: 0 } });
  });

  it('selects a row, leaving the editor at the name asked about', async () => {
    const show = vi.fn(() => Promise.resolve());

    expect(await defining({ row: 'Plugins', show }).definition()).toEqual(OWN);
    expect(show).toHaveBeenCalledOnce();
  });

  it('shows a copy in the Explorer, inside its archive when archived, leaving the editor at the name asked about', async () => {
    const copy: CopyAt = { kind: 'archived', gameRelease: 'Fallout4', archive: '/mods/Mod/Mod - Main.ba2', file: 'meshes/actors/npc.nif' };
    const { definition, reveal } = defining({ shown: copy });

    expect(await definition()).toEqual(OWN);
    expect(reveal.mock.calls).toEqual([[copy]]);
  });

  it('says in the Output why it cannot go, and goes nowhere', async () => {
    const { definition, reporter } = defining({ refused: 'No enabled mod holds meshes/actors/npc.nif.' });

    expect(await definition()).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: 'Go to Definition cannot go to Actors\\Npc.nif.', detail: 'No enabled mod holds meshes/actors/npc.nif.' }]);
  });

  it('writes the reason again each time it recurs (common.md, Reporting: a line in the Output for each reason)', async () => {
    const { definition, reporter } = defining({ refused: 'No enabled mod holds meshes/actors/npc.nif.' });

    await definition();
    await definition();

    expect(reporter.shownFailures).toHaveLength(2);
  });

  it('says why a name that names nothing has no definition', async () => {
    const { definition, reporter } = features(fakeKinds({ file: fakeKind<never>({ nameAt: () => Promise.resolve({ ...SPAN, symbol: { refused: 'no path its asset type holds' } }) }) }));

    expect(await definition()).toBeUndefined();
    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['no path its asset type holds']);
  });

  it('goes nowhere, and says nothing, for a kind with no definition', async () => {
    const { definition, reporter } = defining({ none: 'A profile has no definition.' });

    expect([await definition(), reporter.shownFailures]).toEqual([undefined, []]);
  });

  it('says why the Explorer could not show the copy', async () => {
    const { definition, reveal, reporter } = defining({ shown: { kind: 'loose', path: '/mods/Mod/meshes/actors/npc.nif' } });
    reveal.mockRejectedValueOnce(new Error('The Explorer is gone.'));

    expect(await definition()).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: 'Go to Definition cannot show Actors\\Npc.nif.', detail: 'The Explorer is gone.' }]);
  });
});

describe('Find All References lists the places the symbol\'s kind answers (symbols.md, The features, story 2)', () => {
  const listing = (found: References) => features(claimedBy('file', { referencesTo: () => Promise.resolve(found) }));

  it('writes a line in the Output for each file it could not read, and no notification, a VS Code feature that answers in part (common.md, Reporting)', async () => {
    const { references, reporter } = listing({ locations: [ELSEWHERE], unread: ['/a: unreadable', '/b: unreadable'] });

    expect(await references()).toEqual([ELSEWHERE]);
    expect([reporter.reports, reporter.shownFailures.map(({ severity, message, detail }) => [severity, message, detail])]).toEqual([[], [
      ['warning', 'Find All References on Actors\\Npc.nif could not read a file that may name it.', '/a: unreadable'],
      ['warning', 'Find All References on Actors\\Npc.nif could not read a file that may name it.', '/b: unreadable'],
    ]]);
  });

  it('says in the Output why it cannot list what names a symbol, and lists nothing', async () => {
    const { references, reporter } = listing({ refused: 'Mod order resolves Gone.esp to no plugin.' });

    expect(await references()).toEqual([]);
    expect(reporter.shownFailures).toEqual([{ severity: 'warning', message: 'Find All References cannot list what names Actors\\Npc.nif.', detail: 'Mod order resolves Gone.esp to no plugin.' }]);
  });

  it('writes a line for each file left out, each time it is asked', async () => {
    const { references, reporter } = listing({ locations: [], unread: ['/a: unreadable', '/b: unreadable'] });

    await references();
    await references();

    expect(reporter.shownFailures.map(({ detail }) => detail)).toEqual(['/a: unreadable', '/b: unreadable', '/a: unreadable', '/b: unreadable']);
  });
});

describe('completion offers the symbols of the kind a file names at the place (symbols.md, The features, story 5)', () => {
  it('offers the first kind\'s candidates over its span, inserting what each inserts', async () => {
    const asked = features(fakeKinds({
      entry: fakeKind({ completionsAt: () => Promise.resolve({ start: 12, end: 14, icon: 5, items: [{ label: 'Gun', detail: '000801:Mod.esp', insertText: '000801:Mod.esp' }], isIncomplete: true }) }),
      record: fakeKind({ completionsAt: () => Promise.reject(new Error('Not asked.')) }),
    }));

    expect(await asked.completion()).toEqual({
      isIncomplete: true,
      items: [{ label: { label: 'Gun', description: '000801:Mod.esp' }, kind: 5, insertText: '000801:Mod.esp', filterText: 'Gun 000801:Mod.esp', range: { start: { line: 0, character: 12 }, end: { line: 0, character: 14 } } }],
    });
  });
});

describe('Go to Symbol in Workspace lists every kind\'s symbols (symbols.md, The features, story 4)', () => {
  const listed = (name: string, resolve?: () => Promise<vscode.Location | undefined>) => ({ name, detail: 'a detail', icon: SymbolKind.File, location: ELSEWHERE, resolve });

  it('lists each kind\'s symbols whose name holds the query, the kinds in order', async () => {
    const asked = features(fakeKinds({
      record: fakeKind({ symbolsFor: () => Promise.resolve([listed('Gun')]) }),
      plugin: fakeKind({ symbolsFor: () => Promise.resolve([listed('Gun.esp')]) }),
      file: fakeKind({ symbolsFor: (query) => Promise.resolve([listed(query)]) }),
    }));

    expect((await asked.workspaceSymbols('gun')).map(({ name }) => name)).toEqual(['Gun.esp', 'gun', 'Gun']);
  });

  it('moves the symbol the user picks to where its kind resolves it, and leaves one its kind does not move', async () => {
    const moved = new vscode.Location(vscode.Uri.file('/moved.json'), new vscode.Position(0, 1));
    const asked = features(fakeKinds({ record: fakeKind({ symbolsFor: () => Promise.resolve([listed('Gun', () => Promise.resolve(moved)), listed('Stand')]) }) }));
    const [gun, stand] = await asked.workspaceSymbols('');

    expect([(await asked.resolve(present(gun, 'Gun'))).location, (await asked.resolve(present(stand, 'Stand'))).location]).toEqual([moved, ELSEWHERE]);
  });
});
