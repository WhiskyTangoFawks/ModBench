import { describe, it, expect } from 'vitest';
import { pluginsProvidedOf } from '../pluginsProvided';
import { filesWinningFirst, type DataFolderPlugins, type ModlistEntry, type OriginFile } from '../instanceAdapter';

const file = (relativePath: string, overrides: Partial<OriginFile> = {}): OriginFile =>
  ({ relativePath, path: `/x/${relativePath}`, sourcePath: `/x/${relativePath}`, excluded: false, markedExcluded: false, includedPath: relativePath, ...overrides });
const mod = (name: string, enabled = true): ModlistEntry => ({ kind: 'mod', name, enabled });

describe('the origins that provide files, winning first', () => {
  it('lists Overwrite, then each enabled mod in mod order, each with the files nothing excludes', () => {
    const files = new Map([['A', [file('a.esp'), file('hidden.esp', { excluded: true })]], ['B', [file('b.esp')]], ['Off', [file('off.esp')]]]);
    const order: ModlistEntry[] = [mod('A'), { kind: 'separator', name: 'S', enabled: true }, mod('Off', false), mod('B')];

    const listed = filesWinningFirst(order, [file('o.esp')], (name) => files.get(name) ?? []);

    expect(listed.map(({ origin, files: kept }) => [origin, kept.map((f) => f.relativePath)])).toEqual([
      [{ kind: 'runtimeOutput' }, ['o.esp']],
      [{ kind: 'mod', name: 'A' }, ['a.esp']],
      [{ kind: 'mod', name: 'B' }, ['b.esp']],
    ]);
  });
});

describe('the plugins each origin provides', () => {
  const listedIn = (...names: string[]): DataFolderPlugins => ({ kind: 'listed', names: new Set(names) });
  const pluginsOf = (winningFirst: Parameters<typeof pluginsProvidedOf>[0], data = listedIn()) => {
    const provided = pluginsProvidedOf(winningFirst, data, []);
    return provided.kind === 'listed' ? provided.plugins : provided;
  };

  it('keys each plugin at an origin\'s root as the game compares names, at the spelling of the first copy', () => {
    expect(pluginsOf([
      { origin: { kind: 'runtimeOutput' }, files: [file('A.esp')] },
      { origin: { kind: 'mod', name: 'M' }, files: [file('a.esp'), file('Zeta.esp', { sourcePath: '/store/abc123.esp' })] },
    ])).toEqual(new Map([['a.esp', 'A.esp'], ['zeta.esp', 'Zeta.esp']]));
  });

  it('leaves out a file that is not a plugin, and a plugin below an origin\'s root', () => {
    expect(pluginsOf([{ origin: { kind: 'mod', name: 'M' }, files: [file('readme.txt'), file('Optional/B.esp')] }])).toEqual(new Map());
  });

  it('answers a Data folder plugin no origin provides, at the first of its spellings in code-point order, and an origin\'s copy over the Data folder\'s', () => {
    expect(pluginsOf([{ origin: { kind: 'mod', name: 'M' }, files: [file('MASTER.ESM')] }], listedIn('master.esm', 'loose.esp', 'Loose.esp')))
      .toEqual(new Map([['master.esm', 'MASTER.ESM'], ['loose.esp', 'Loose.esp']]));
  });

  it.each<DataFolderPlugins>([{ kind: 'unresolved' }, { kind: 'unreadable', reason: 'EACCES' }])('answers why there are none when the Data folder is $kind', (data) => {
    expect(pluginsProvidedOf([], data, [])).toEqual(data);
  });

  it('answers the plugins the game loads with no line as it is handed them', () => {
    expect(pluginsProvidedOf([], listedIn(), ['Master.esm'])).toMatchObject({ loadedWithNoLine: ['Master.esm'] });
  });
});
