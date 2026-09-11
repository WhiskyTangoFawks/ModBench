import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so a Toolbox gesture can be invoked directly.
const { handlers, registerCommand, showQuickPick, fetchTasks, executeTask } = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: () => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
    fetchTasks: vi.fn(),
    executeTask: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  commands: { registerCommand },
  window: { showQuickPick },
  tasks: { fetchTasks, executeTask },
}));

const { deployMods, purgeMods, listProfiles, switchProfile } = vi.hoisted(() => ({
  deployMods: vi.fn(),
  purgeMods: vi.fn(),
  listProfiles: vi.fn(),
  switchProfile: vi.fn(),
}));

vi.mock('../modmanager/commands/deployment', () => ({ deployMods, purgeMods }));
vi.mock('../modmanager/commands/profile', () => ({ listProfiles, switchProfile }));
vi.mock('../workspaceConfig', () => ({
  meditConfig: () => ({ get: () => undefined }),
  makeDetectPaths: () => () => Promise.resolve({ pluginsTxt: '/instance/profiles/Default/plugins.txt' }),
}));

import { registerToolboxCommands, type ToolboxCommandDeps } from '../toolboxCommands';
import { recordingReporter, scriptedDialog } from './surfacingDoubles';
import type { Instance } from '../modmanager/instance';

const value = { activeProfile: 'Default', files: { winners: new Map() }, gameDirectory: { dataFolder: '/game/Data' } };

function register(over: Partial<ToolboxCommandDeps> = {}) {
  const reporter = recordingReporter();
  const ask = scriptedDialog();
  const updateProfileDescription = vi.fn(() => Promise.resolve());
  registerToolboxCommands({
    instanceRoot: '/instance',
    instance: { value } as unknown as Pick<Instance, 'value'>,
    outputChannel: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    updateProfileDescription,
    reporterFor: () => reporter,
    ask,
    ...over,
  });
  return { reporter, ask, updateProfileDescription, run: (id: string) => handlers.get(id)!() };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('Deploy and Purge', () => {
  it('lands the deployed toast once the deployment wrote a manifest', async () => {
    deployMods.mockResolvedValueOnce({ applied: true, wrote: true });

    const { reporter, run } = register();
    await run('modbench.toolbox.deploy');

    expect(reporter.landings).toEqual(['Mods deployed.']);
    expect(reporter.reports).toEqual([]);
  });

  it('lands the purged toast once the purge wrote', async () => {
    purgeMods.mockResolvedValueOnce({ applied: true, wrote: true });

    const { reporter, run } = register();
    await run('modbench.toolbox.purge');

    expect(reporter.landings).toEqual(['Deployed mods purged.']);
  });

  // The rival: landing the toast on every applied outcome. A deployment that wrote nothing
  // aborted and said so itself, so a second "Mods deployed." would contradict it.
  it('lands nothing when the deployment aborted without writing', async () => {
    deployMods.mockResolvedValueOnce({ applied: true, wrote: false });

    const { reporter, run } = register();
    await run('modbench.toolbox.deploy');

    expect(reporter.landings).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('reports a refusal at error with the refusal as its detail, and lands nothing', async () => {
    deployMods.mockResolvedValueOnce({ applied: false, refusal: 'no game directory is resolved' });

    const { reporter, run } = register();
    await run('modbench.toolbox.deploy');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Deploy failed.', detail: 'no game directory is resolved' },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports a thrown deployment as its own refusal', async () => {
    purgeMods.mockRejectedValueOnce(new Error('the link farm is locked'));

    const { reporter, run } = register();
    await run('modbench.toolbox.purge');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Purge failed.', detail: 'the link farm is locked' },
    ]);
  });

  it('hands the deployment the same reporter and dialog it surfaces through', async () => {
    deployMods.mockResolvedValueOnce({ applied: true, wrote: true });

    const { reporter, ask, run } = register();
    await run('modbench.toolbox.deploy');

    expect(deployMods).toHaveBeenCalledWith(
      '/instance', 'Default', value.files, value.gameDirectory,
      '/instance/profiles/Default/plugins.txt', reporter, ask,
    );
  });
});

describe('Launch…', () => {
  it('lands the no-targets message and starts nothing when no task is contributed', async () => {
    fetchTasks.mockResolvedValueOnce([]);

    const { reporter, run } = register();
    await run('modbench.toolbox.launch');

    expect(reporter.landings).toEqual([
      'No launch targets — add an executable to MO2\'s executables list and it appears here.',
    ]);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('runs the picked task', async () => {
    const task = { name: 'Fallout 4' };
    fetchTasks.mockResolvedValueOnce([task]);
    showQuickPick.mockResolvedValueOnce({ label: 'Fallout 4', task });

    const { reporter, run } = register();
    await run('modbench.toolbox.launch');

    expect(executeTask).toHaveBeenCalledWith(task);
    expect(reporter.landings).toEqual([]);
  });
});

describe('Switch profile', () => {
  it('reports a refused switch at error and leaves the readout alone', async () => {
    listProfiles.mockResolvedValueOnce(['Default', 'Modding']);
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: false, refusal: 'ModOrganizer.ini is read-only' });

    const { reporter, updateProfileDescription, run } = register();
    await run('modbench.toolbox.switchProfile');

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to switch profile.', detail: 'ModOrganizer.ini is read-only' },
    ]);
    expect(updateProfileDescription).not.toHaveBeenCalled();
  });

  it('refreshes the readout once the switch lands, and surfaces nothing', async () => {
    listProfiles.mockResolvedValueOnce(['Default', 'Modding']);
    showQuickPick.mockResolvedValueOnce({ label: 'Modding' });
    switchProfile.mockResolvedValueOnce({ applied: true });

    const { reporter, updateProfileDescription, run } = register();
    await run('modbench.toolbox.switchProfile');

    expect(updateProfileDescription).toHaveBeenCalled();
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('switches nothing when the picked profile is the active one', async () => {
    listProfiles.mockResolvedValueOnce(['Default']);
    showQuickPick.mockResolvedValueOnce({ label: 'Default' });

    const { run } = register();
    await run('modbench.toolbox.switchProfile');

    expect(switchProfile).not.toHaveBeenCalled();
  });
});
