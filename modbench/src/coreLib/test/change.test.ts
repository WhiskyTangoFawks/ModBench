import { describe, expect, it } from 'vitest';
import { NO_FILE_CHANGES, type Committed, type FileChanges, type Planned, type RenamePlan } from '../../symbolNames/symbolNames';
import { change } from '../change';

const edit = (path: string): FileChanges => ({ ...NO_FILE_CHANGES, documents: [{ path, text: 'new' }] });

interface Owner {
  readonly name: string;
  readonly planned: Partial<RenamePlan> | { refused: string };
}

const owner = (name: string, planned: Owner['planned'] = {}): Owner => ({ name, planned });

function planning(log: string[]) {
  return ({ name, planned }: Owner): Promise<Planned> => {
    log.push(`plan ${name}`);
    if ('refused' in planned) return Promise.resolve(planned);
    return Promise.resolve({
      changes: NO_FILE_CHANGES, cannotFollow: [], ...planned,
      commit: (): Promise<Committed> => {
        log.push(`commit ${name}`);
        return planned.commit?.() ?? Promise.resolve({ cannotFollow: [] });
      },
    });
  };
}

function applying(log: string[], unapplied?: string) {
  return (changes: readonly FileChanges[]): Promise<string | undefined> => {
    log.push(`apply ${changes.flatMap(({ documents }) => documents.map(({ path }) => path)).join(',')}`);
    return Promise.resolve(unapplied);
  };
}

const committing = (committed: Committed): RenamePlan['commit'] => () => Promise.resolve(committed);

describe('change: a rename that carries every reference', () => {
  it('plans with every owner, applies every change as one edit, then commits each, the definition last', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition', { changes: edit('/definition') }), references: [owner('source', { changes: edit('/source') }), owner('build', { changes: edit('/build') })] };

    const result = await change(owners, planning(log), applying(log));

    expect(result).toEqual({ applied: true, cannotFollow: [] });
    expect(log.slice(3)).toEqual(['apply /source,/build,/definition', 'commit source', 'commit build', 'commit definition']);
    expect(log.slice(0, 3).sort()).toEqual(['plan build', 'plan definition', 'plan source']);
  });

  it('lands with each reference no owner can carry, planned or found by its commit', async () => {
    const owners = {
      definition: owner('definition', { cannotFollow: ['a'], commit: committing({ cannotFollow: ['d'] }) }),
      references: [owner('source', { cannotFollow: ['b', 'c'] })],
    };

    expect(await change(owners, planning([]), applying([]))).toEqual({ applied: true, cannotFollow: ['b', 'c', 'a', 'd'] });
  });

  it('writes nothing when an owner refuses, and says why', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition'), references: [owner('source', { refused: 'name taken' })] };

    expect(await change(owners, planning(log), applying(log))).toEqual({ applied: false, refusal: 'name taken' });
    expect(log.filter((line) => !line.startsWith('plan'))).toEqual([]);
  });

  it('commits nothing when the changes are not applied', async () => {
    const log: string[] = [];
    const owners = { definition: owner('definition'), references: [owner('source', { changes: edit('/source') })] };

    expect(await change(owners, planning(log), applying(log, 'VS Code did not apply the changes.')))
      .toEqual({ applied: false, unapplied: 'VS Code did not apply the changes.' });
    expect(log.filter((line) => line.startsWith('commit'))).toEqual([]);
  });

  const MOVE = { from: '/source/Old', to: '/source/New' };

  it.each<[string, Partial<RenamePlan>, boolean, readonly (typeof MOVE)[]]>([
    ['were applied', { changes: { ...edit('/source'), moves: [MOVE] } }, true, [MOVE]],
    ['were none', {}, false, []],
  ])('stops at a commit that fails, saying whether changes %s before it, and what moved', async (_case, planned, edited, moved) => {
    const log: string[] = [];
    const owners = { definition: owner('definition'), references: [owner('source', { ...planned, commit: committing({ failed: 'disk full' }) })] };

    expect(await change(owners, planning(log), applying(log))).toEqual({ applied: false, failed: 'disk full', edited, moved });
    expect(log.filter((line) => line.startsWith('commit'))).toEqual(['commit source']);
  });
});
