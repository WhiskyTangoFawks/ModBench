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

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
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
    commands: { checkForUpdates },
    instance: { value, ...instanceThatReads },
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

    expect(checkForUpdates).toHaveBeenCalledWith(['ModA', 'ModB']);
  });

  it('says in one line how many mods have an update, and names each mod it could not ask about in the Output', async () => {
    checkForUpdates.mockResolvedValue({
      applied: true,
      outcome: {
        landed: [{ name: 'ModA', updateAvailable: true }],
        refused: [{ item: { name: 'ModB' }, reason: 'it has no Nexus mod ID' }],
      },
    });
    const { reporter, run } = register();

    await run(CHECK, modRow('ModA'), [modRow('ModA'), folderRow]);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Check for updates: 1 mod has an update, 2 could not be asked about.',
      detail: '"ModB" (it has no Nexus mod ID)\n"meshes" (it is not a mod or a separator)',
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

describe('check for updates, on a separator', () => {
  const separatorRow = { argument: { kind: 'separator', name: 'Weapons' }, name: 'Weapons' };

  it('asks about the mods the separator holds, and not about the separator', async () => {
    const { run } = register();

    await run(CHECK, separatorRow, [separatorRow]);

    expect(checkForUpdates).toHaveBeenCalledWith(['ModA']);
  });

  it('runs under the Mods view when no row is selected', async () => {
    const { run } = register();

    await run(CHECK);

    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
  });
});

describe('check for updates, from an agent', () => {
  it('asks about every mod when the call names none, and answers the outcome', async () => {
    checkForUpdates.mockResolvedValue({
      applied: true,
      outcome: { landed: [{ name: 'ModA', updateAvailable: true }], refused: [{ item: { name: 'ModB' }, reason: 'it has no Nexus mod ID' }] },
    });
    const { run } = register();

    const answer = await run(CHECK, new AgentCall([], {}));

    expect(checkForUpdates).toHaveBeenCalledWith(['ModA', 'ModB']);
    expect(answer).toEqual({
      applied: true,
      outcome: { landed: [{ name: 'ModA', updateAvailable: true }], refused: [{ item: { name: 'ModB' }, reason: 'it has no Nexus mod ID' }] },
    });
  });

  it('answers a refusal of the whole call as a refusal', async () => {
    checkForUpdates.mockResolvedValue({ applied: false, refusal: 'You are not logged in to Nexus.' });
    const { run } = register();

    expect(await run(CHECK, new AgentCall([], {}))).toEqual({ applied: false, refusal: 'You are not logged in to Nexus.' });
  });
});
