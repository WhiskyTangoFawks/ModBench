import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { mod } from './indexedValue';
import { AgentCall } from '../../drivingLib/agentGesture';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import type { InitProgress } from '../../sourceCommands/sourceCommands';

describe('the version in git phase line', () => {
  it.each([
    ['Parsing', 'Version in git "MyMod" — parsing…'],
    ['Serializing', 'Version in git "MyMod" — serializing…'],
    ['ReadingFiles', 'Version in git "MyMod" — reading its files…'],
    ['Committing', 'Version in git "MyMod" — writing the repository…'],
    [undefined, 'Version in git "MyMod"…'],
    [null, 'Version in git "MyMod"…'],
  ] as const satisfies readonly (readonly [InitProgress['phase'], string])[])('says %s as %s', async (phase, message) => {
    const said: (string | undefined)[] = [];
    const { view, run } = modsViewOn({
      value: instanceValueFixture({ mods: [mod('First'), mod('MyMod')] }),
      sourceCommands: {
        versionInGit: (_mods, { onProgress }) => {
          onProgress?.({ mod: 'MyMod', phase, modsDone: 0, modsTotal: 2 });
          said.push(view.message);
          return Promise.resolve({ landed: [], refused: [] });
        },
      },
    });

    await run('modbench.mod.versionInGit', new AgentCall([{ kind: 'mod', name: 'First' }, { kind: 'mod', name: 'MyMod' }], { commit: false, where: 'NewRepository' }));

    expect(said).toEqual([message]);
  });
});
