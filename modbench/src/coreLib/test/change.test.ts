import { describe, expect, it } from 'vitest';
import { heldTexts, NO_FILE_CHANGES, type FileChanges, type RenamePlan, type SymbolOwner } from '../../symbolNames/symbolNames';
import { change } from '../change';

const PLUGIN = { name: 'Old.esp', origin: 'Mod' };

const edit = (path: string): FileChanges => ({ ...NO_FILE_CHANGES, documents: [{ path, text: 'new' }] });

const failing = (why: string): RenamePlan['commit'] => () => Promise.resolve(why);

function owner(name: string, log: string[], planned: Partial<RenamePlan> | { refused: string } = {}): SymbolOwner {
  return {
    read: () => Promise.resolve({ references: [], leftOut: [] }),
    nameAt: () => Promise.resolve(undefined),
    plan: (symbol, newName, held, plugins) => {
      log.push(`plan ${name} ${symbol.name}>${newName} ${String(held.byPath.size)} ${plugins.map(({ origin }) => origin).join()}`);
      if ('refused' in planned) return Promise.resolve(planned);
      return Promise.resolve({
        changes: NO_FILE_CHANGES, cannotFollow: [], ...planned,
        commit: () => {
          log.push(`commit ${name}`);
          return planned.commit?.() ?? Promise.resolve(undefined);
        },
      });
    },
  };
}

function changing(log: string[], owners: { definition: SymbolOwner; references: SymbolOwner[] }, applied?: string) {
  return {
    owners,
    held: heldTexts([['/unsaved.json', '{}']]),
    plugins: [{ ...PLUGIN, origin: 'Winning Mod', winning: true }],
    apply: (changes: readonly FileChanges[]) => {
      log.push(`apply ${changes.flatMap(({ documents }) => documents.map(({ path }) => path)).join(',')}`);
      return Promise.resolve(applied);
    },
  };
}

describe('change: a rename that carries every reference', () => {
  it('plans with every owner over the held texts and the rows, applies every change as one edit, then commits each, the definition last', async () => {
    const log: string[] = [];
    const owners = {
      definition: owner('definition', log, { changes: edit('/definition') }),
      references: [owner('source', log, { changes: edit('/source') }), owner('build', log, { changes: edit('/build') })],
    };

    const result = await change(changing(log, owners), PLUGIN, 'New.esp');

    expect(result).toEqual({ applied: true, cannotFollow: [] });
    expect(log.slice(3)).toEqual(['apply /source,/build,/definition', 'commit source', 'commit build', 'commit definition']);
    expect(log.slice(0, 3).sort()).toEqual([
      'plan build Old.esp>New.esp 1 Winning Mod', 'plan definition Old.esp>New.esp 1 Winning Mod', 'plan source Old.esp>New.esp 1 Winning Mod',
    ]);
  });

  it('lands with each reference no owner can carry', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log, { cannotFollow: ['a'] }), references: [owner('source', log, { cannotFollow: ['b', 'c'] })] };

    expect(await change(changing(log, owners), PLUGIN, 'New.esp')).toEqual({ applied: true, cannotFollow: ['b', 'c', 'a'] });
  });

  it('writes nothing when an owner refuses, and says why', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log), references: [owner('source', log, { refused: 'name taken' })] };

    expect(await change(changing(log, owners), PLUGIN, 'New.esp')).toEqual({ applied: false, refusal: 'name taken' });
    expect(log.filter((line) => !line.startsWith('plan'))).toEqual([]);
  });

  it('commits nothing when the changes are not applied', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log), references: [owner('source', log, { changes: edit('/source') })] };

    expect(await change(changing(log, owners, 'VS Code did not apply the changes.'), PLUGIN, 'New.esp'))
      .toEqual({ applied: false, unapplied: 'VS Code did not apply the changes.' });
    expect(log.filter((line) => line.startsWith('commit'))).toEqual([]);
  });

  it.each<[string, Partial<RenamePlan>, boolean]>([
    ['were applied', { changes: edit('/source') }, true],
    ['were none', {}, false],
  ])('stops at a commit that fails, saying whether changes %s before it', async (_case, planned, edited) => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log), references: [owner('source', log, { ...planned, commit: failing('disk full') })] };

    expect(await change(changing(log, owners), PLUGIN, 'New.esp')).toEqual({ applied: false, failed: 'disk full', edited });
    expect(log.filter((line) => line.startsWith('commit'))).toEqual(['commit source']);
  });
});
