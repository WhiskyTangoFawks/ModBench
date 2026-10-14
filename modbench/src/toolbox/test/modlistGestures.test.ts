import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: recordedWithProgress },
    TreeItem: class { readonly label = ''; },
  };
});

import { progressSteps } from '../../test/recordedProgress';
import { registerModlistCommands } from '../modlistGestures';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { ModlistSourceCommands } from '../../sourceCommands/modlistSourceCommands';

const init = vi.fn<ModlistSourceCommands['init']>();
const stage = vi.fn<ModlistSourceCommands['stage']>();

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'ModA', enabled: true },
    { kind: 'separator', name: 'Weapons', enabled: true },
    { kind: 'mod', name: 'ModB', enabled: false },
  ],
});

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });

function register() {
  const reporter = recordingReporter();
  registerModlistCommands({
    commands: { init, stage },
    instance: { value, refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    reporter, modsView: 'modbench.modList',
  });
  return { reporter, run: (id: string, ...args: unknown[]) => present(handlers.get(id), `the handler for "${id}"`)(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  init.mockResolvedValue({ applied: true });
  stage.mockResolvedValue({ applied: true, landed: [], refused: [] });
});

describe('Init', () => {
  it('makes the repository under the Toolbox\'s progress, which closes once the Instance loader has read again, and says nothing', async () => {
    init.mockImplementationOnce(() => { progressSteps.push('init'); return Promise.resolve({ applied: true }); });
    const { reporter, run } = register();

    await run('modbench.modlist.init');

    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'init', 'Instance loader: read every file again', 'progress closes']);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('reports a refusal at error, naming why', async () => {
    init.mockResolvedValueOnce({ applied: false, refusal: '/instance already holds a repository.' });
    const { reporter, run } = register();

    await run('modbench.modlist.init');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not init the modlist.', detail: '/instance already holds a repository.' }]);
  });
});

describe('Stage', () => {
  it('stages every mod, no separator, from the palette or the Source Control title bar, whatever that hands it', async () => {
    const { run } = register();

    await run('modbench.modlist.stage');
    await run('modbench.modlist.stage', { rootUri: undefined });

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB'], ['ModA', 'ModB']]);
  });

  it('stages the selected mods from the Mod menu', async () => {
    const { run } = register();

    await run('modbench.modlist.stage', modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB']]);
  });

  it('stages under the Mods view\'s progress when a Mods row asked, and asks nothing', async () => {
    stage.mockImplementationOnce(() => { progressSteps.push('stage'); return Promise.resolve({ applied: true, landed: [], refused: [] }); });
    const { run } = register();

    await run('modbench.modlist.stage', modRow('ModA'));

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'stage', 'Instance loader: read every file again', 'progress closes']);
  });

  it('stages under the Toolbox\'s progress from anywhere else', async () => {
    const { run } = register();

    await run('modbench.modlist.stage');

    expect(progressSteps[0]).toBe('progress opens on modbench.toolbox');
  });

  it('says what it staged', async () => {
    stage.mockResolvedValueOnce({ applied: true, landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }], refused: [] });
    const { reporter, run } = register();

    await run('modbench.modlist.stage', modRow('ModA'));

    expect(reporter.landings).toEqual(['Staged "ModA".']);
  });

  it('names each refused mod with why, and does not call the mods that landed failed', async () => {
    stage.mockResolvedValueOnce({
      applied: true,
      landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }],
      refused: [{ item: 'ModB', reason: "'ModB' was not staged: 'B.zip' not in the downloads folder." }],
    });
    const { reporter, run } = register();

    await run('modbench.modlist.stage');

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not stage 1 of 2 mods.', detail: `"ModB" ('ModB' was not staged: 'B.zip' not in the downloads folder.)`,
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports each file nothing provides, by mod, and still says the rest landed', async () => {
    stage.mockResolvedValueOnce({
      applied: true,
      landed: [{ mod: 'ModA', manifestWritten: true, noProvider: ['a.nif', 'b/c.dds'] }],
      refused: [],
    });
    const { reporter, run } = register();

    await run('modbench.modlist.stage', modRow('ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: '2 files have no provider.', detail: 'ModA: a.nif\nModA: b/c.dds',
    }]);
    expect(reporter.landings).toEqual(['Staged "ModA".']);
  });

  it('refuses a selected row that is not a mod, naming it', async () => {
    const { reporter, run } = register();

    await run('modbench.modlist.stage', modRow('ModA'), [modRow('ModA'), { argument: { kind: 'separator', name: 'Weapons' }, name: 'Weapons' }]);

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not stage 1 of 2 mods.', detail: '"Weapons" (it is not a mod)' }]);
  });

  it('reports a stage mEdit refused whole', async () => {
    stage.mockResolvedValueOnce({ applied: false, refusal: 'Could not stage 2 mods — mEdit is not running.' });
    const { reporter, run } = register();

    await run('modbench.modlist.stage');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not stage 2 mods — mEdit is not running.', detail: undefined }]);
  });
});
