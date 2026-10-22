import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: (options: { location: { viewId: string } }, task: () => Promise<unknown>) => recordedWithProgress(options, task) },
    TreeItem: class { constructor(readonly label: string) {} },
  };
});

import { progressSteps } from '../../test/recordedProgress';
import { registerCheckForUpdatesGestures } from '../checkForUpdatesGestures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { CheckForUpdates } from '../../modCommands/checkForUpdates';

const checkForUpdates = vi.fn<CheckForUpdates>();

const CHECK = 'modbench.mod.checkForUpdates';

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'ModA', enabled: true },
    { kind: 'separator', name: 'Weapons', enabled: true },
    { kind: 'mod', name: 'ModB', enabled: false },
  ],
  modFolders: [
    { kind: 'mod', name: 'ModA', path: '/instance/mods/ModA', modName: 'ModA' },
    { kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' },
    { kind: 'mod', name: 'ModB', path: '/instance/mods/ModB', modName: 'ModB' },
  ],
});

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });
const folderRow = { argument: { kind: 'folder', path: '/instance/mods/ModA/meshes' }, name: 'meshes' };

function register() {
  const reporter = recordingReporter();
  registerCheckForUpdatesGestures({
    toolboxView: 'modbench.toolbox', commands: { checkForUpdates },
    instance: { value, refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    reporter, focusedView: { id: () => undefined, selection: () => [] },
  });
  return { reporter, run: (id: string, ...args: unknown[]) => present(handlers.get(id), `the handler for "${id}"`)(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  checkForUpdates.mockResolvedValue({ applied: true, outcome: { landed: [], refused: [] } });
});

describe('check for updates, from a view', () => {
  it('asks about the selected mods and reads the instance again once they are written', async () => {
    const { run } = register();

    await run(CHECK, modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(checkForUpdates).toHaveBeenCalledWith(['ModA', 'ModB']);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'Instance loader: read every file again', 'progress closes']);
  });

  it('asks about every mod from the Mods title bar', async () => {
    const { run } = register();

    await run('modbench.modList.checkForUpdatesHere');

    expect(checkForUpdates).toHaveBeenCalledWith(['ModA', 'Weapons_separator', 'ModB']);
  });

  it('says in one line how many mods have an update, and names each mod it could not ask about in the Output', async () => {
    checkForUpdates.mockResolvedValue({
      applied: true,
      outcome: {
        landed: [{ name: 'ModA', updateAvailable: true }, { name: 'ModB', updateAvailable: false }],
        refused: [{ item: { name: 'Weapons_separator' }, reason: 'it has no Nexus mod ID' }],
      },
    });
    const { reporter, run } = register();

    await run(CHECK, modRow('ModA'), [modRow('ModA'), folderRow]);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Check for updates: 1 mod has an update, 2 could not be asked about.',
      detail: '"separator Weapons" (it has no Nexus mod ID)\n"meshes" (it is not a mod or a separator)',
    }]);
  });

  it('lands the line when every mod could be asked about', async () => {
    checkForUpdates.mockResolvedValue({ applied: true, outcome: { landed: [{ name: 'ModA', updateAvailable: true }, { name: 'ModB', updateAvailable: true }], refused: [] } });
    const { reporter, run } = register();

    await run(CHECK, modRow('ModA'));

    expect([reporter.landings, reporter.reports]).toEqual([['Check for updates: 2 mods have an update, 0 could not be asked about.'], []]);
  });

  it('reports a refusal of the whole selection as an error', async () => {
    checkForUpdates.mockResolvedValue({ applied: false, refusal: 'You are not logged in to Nexus.' });
    const { reporter, run } = register();

    await run(CHECK, modRow('ModA'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'You are not logged in to Nexus.', detail: undefined }]);
  });
});

describe('check for updates, from an agent', () => {
  it('asks about every mod when the call names none, and answers the outcome by the names the Mods view shows', async () => {
    checkForUpdates.mockResolvedValue({
      applied: true,
      outcome: { landed: [{ name: 'ModA', updateAvailable: true }], refused: [{ item: { name: 'Weapons_separator' }, reason: 'it has no Nexus mod ID' }] },
    });
    const { run } = register();

    const answer = await run(CHECK, new AgentCall([], {}));

    expect(checkForUpdates).toHaveBeenCalledWith(['ModA', 'Weapons_separator', 'ModB']);
    expect(answer).toEqual({
      applied: true,
      outcome: { landed: [{ name: 'ModA', updateAvailable: true }], refused: [{ item: { name: 'separator Weapons' }, reason: 'it has no Nexus mod ID' }] },
    });
  });
});
