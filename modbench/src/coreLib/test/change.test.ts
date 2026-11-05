import { describe, expect, it } from 'vitest';
import { heldTexts, NO_FILE_CHANGES, type FileChanges, type RenamePlan, type SymbolOwner } from '../../symbolNames/symbolNames';
import { change } from '../change';

const PLUGIN = { name: 'Old.esp', origin: 'Mod' };

const edit = (path: string): FileChanges => ({ ...NO_FILE_CHANGES, documents: [{ path, text: 'new' }] });

function owner(name: string, log: string[], planned: Partial<RenamePlan> | { refused: string } | Error = {}): SymbolOwner {
  return {
    read: () => Promise.resolve({ references: [], leftOut: [] }),
    nameAt: () => Promise.resolve(undefined),
    plan: (symbol, newName, held) => {
      log.push(`plan ${name} ${symbol.name}>${newName} ${String(held.byPath.size)}`);
      if (planned instanceof Error) return Promise.reject(planned);
      if ('refused' in planned) return Promise.resolve(planned);
      return Promise.resolve({
        changes: NO_FILE_CHANGES, cannotFollow: [], ...planned,
        commit: async () => {
          log.push(`commit ${name}`);
          await planned.commit?.();
        },
      });
    },
  };
}

function changing(log: string[], owners: { definition: SymbolOwner; references: SymbolOwner[] }, applied?: string) {
  return {
    owners,
    held: heldTexts([['/unsaved.json', '{}']]),
    apply: (changes: readonly FileChanges[]) => {
      log.push(`apply ${changes.flatMap(({ documents }) => documents.map(({ path }) => path)).join(',')}`);
      return Promise.resolve(applied);
    },
  };
}

describe('change: a rename that carries every reference', () => {
  it('plans with every owner over the held texts, applies every change as one edit, then commits each, the definition last', async () => {
    const log: string[] = [];
    const owners = {
      definition: owner('definition', log, { changes: edit('/definition') }),
      references: [owner('source', log, { changes: edit('/source') }), owner('build', log, { changes: edit('/build') })],
    };

    const result = await change(changing(log, owners), PLUGIN, 'New.esp');

    expect(result).toEqual({ applied: true, cannotFollow: [] });
    expect(log.slice(3)).toEqual(['apply /source,/build,/definition', 'commit source', 'commit build', 'commit definition']);
    expect(log.slice(0, 3).sort()).toEqual(['plan build Old.esp>New.esp 1', 'plan definition Old.esp>New.esp 1', 'plan source Old.esp>New.esp 1']);
  });

  it('lands with each reference no owner can carry', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log, { cannotFollow: ['a'] }), references: [owner('source', log, { cannotFollow: ['b', 'c'] })] };

    expect(await change(changing(log, owners), PLUGIN, 'New.esp')).toEqual({ applied: true, cannotFollow: ['b', 'c', 'a'] });
  });

  it.each<[string, { refused: string } | Error]>([
    ['refuses', { refused: 'name taken' }],
    ['fails to plan', new Error('name taken')],
  ])('writes nothing when an owner %s, and says why', async (_case, planned) => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log), references: [owner('source', log, planned)] };

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

  it('stops at a commit that fails, saying whether the changes were applied before it', async () => {
    const log: string[] = [];
    const failing = { commit: () => Promise.reject(new Error('disk full')), changes: edit('/source') };
    const owners = { definition: owner('definition', log), references: [owner('source', log, failing)] };

    expect(await change(changing(log, owners), PLUGIN, 'New.esp')).toEqual({ applied: false, failed: 'disk full', edited: true });
    expect(log.filter((line) => line.startsWith('commit'))).toEqual(['commit source']);
  });

  it('says no change was applied before a failed commit when no owner had one', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition', log, { commit: () => Promise.reject(new Error('disk full')) }), references: [] };

    expect(await change(changing(log, owners), PLUGIN, 'New.esp')).toEqual({ applied: false, failed: 'disk full', edited: false });
  });
});
