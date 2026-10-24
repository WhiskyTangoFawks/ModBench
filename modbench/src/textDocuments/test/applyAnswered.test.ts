import { describe, it, expect } from 'vitest';
import { applyAnswered, type ApplyingSource } from '../applyAnswered';
import type { WorkspaceChanges } from '../applyWorkspaceChanges';
import type { PluginAddress } from '../../wire/pluginAddress';

const CHANGES: WorkspaceChanges = { moves: [], deletions: [], documents: [{ path: '/source/ModA/plugin-source/A.esp/Gun.json', text: '{}' }] };
const A = { name: 'A.esp', origin: 'ModA' };
const B = { name: 'B.esp', origin: 'ModB' };

function source(refusal?: string) {
  const applied: (readonly WorkspaceChanges[])[] = [];
  const refreshed: PluginAddress[] = [];
  const applying: ApplyingSource = {
    applyWorkspaceChanges: (items) => {
      applied.push(items);
      return refusal === undefined ? Promise.resolve() : Promise.reject(new Error(refusal));
    },
    refreshSourceControlFor: (plugin) => { refreshed.push(plugin); },
  };
  return { applying, applied, refreshed };
}

describe('applying the changes mEdit answered', () => {
  it('applies them as one edit, answers nothing, and refreshes Source Control once for each plugin touched', async () => {
    const { applying, applied, refreshed } = source();

    expect(await applyAnswered(applying, [CHANGES, CHANGES], [A, B, { ...A }])).toBeUndefined();
    expect([applied, refreshed]).toEqual([[[CHANGES, CHANGES]], [A, B]]);
  });

  it('answers why VS Code could not apply them, and still refreshes Source Control for each plugin touched, since some may have landed', async () => {
    const { applying, refreshed } = source('EEXIST');

    expect(await applyAnswered(applying, [CHANGES], [A])).toBe('EEXIST VS Code stops at the first change it cannot make, so some changes may have landed.');
    expect(refreshed).toEqual([A]);
  });

  it('applies no edit when mEdit answered no changes', async () => {
    const { applying, applied, refreshed } = source();

    expect(await applyAnswered(applying, [], [A])).toBeUndefined();
    expect([applied, refreshed]).toEqual([[], [A]]);
  });
});
