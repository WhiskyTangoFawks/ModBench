import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => (await import('./sourceGestureHarness')).vscodeModule());

import { executeCommand } from './sourceGestureHarness';
import { buildTargetsOf, publishBuildTargets } from '../buildTargets';

beforeEach(() => { vi.clearAllMocks(); });

const DIRS = new Map([['ModA', '/instance/source/ModA']]);

describe('buildTargetsOf', () => {
  it('maps a source mod\'s folder and its build file to the mod', () => {
    expect(buildTargetsOf(DIRS)).toEqual(new Map([
      ['file:///instance/source/ModA', 'ModA'], ['file:///instance/source/ModA/build.json', 'ModA'],
    ]));
  });
});

describe('publishBuildTargets', () => {
  it('sets the context key to every folder and build file', () => {
    publishBuildTargets(DIRS);

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'modbench.source.buildTargets', [
      'file:///instance/source/ModA', 'file:///instance/source/ModA/build.json',
    ]);
  });
});
