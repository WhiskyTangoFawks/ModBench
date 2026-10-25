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
import { checkForUpdatesOver } from '../../modCommands/checkForUpdates';
import { fakeInstanceAdapter, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { GOOD_KEY, nexusAnswering } from '../../nexus/test/nexusDouble';

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

const onNexus = (modId: string) => ({ kind: 'read', answer: { game: 'fallout4', modId, fileId: '1', fileName: undefined, fileStatus: undefined } } as const);
const ON_NEXUS: InstanceAnswers = { nexusFiles: new Map([['ModA', onNexus('1')], ['ModB', onNexus('2')]]), updatable: new Set(['ModA', 'ModB']) };
const NEWEST = '2.0';
const listing = (): Response =>
  new Response(JSON.stringify({ files: [{ file_id: 1, version: NEWEST, category_id: 1, file_name: 'a.7z' }], file_updates: [] }), { status: 200 });
const checked = (...mods: string[]): AdapterCall[] => mods.map((mod) => ({ verb: 'writeNewestVersion', mod, version: NEWEST }));

async function register({ answers = ON_NEXUS, loggedIn = true }: { answers?: InstanceAnswers; loggedIn?: boolean } = {}) {
  const fake = fakeInstanceAdapter(undefined, answers);
  const { nexus } = nexusAnswering(listing);
  if (loggedIn) await nexus.keep(GOOD_KEY);
  const reporter = recordingReporter();
  registerCheckForUpdatesGestures({
    commands: { checkForUpdates: checkForUpdatesOver(fake.adapter, nexus) },
    instance: { value, ...instanceThatReads },
    reporter, focusedView: { id: () => undefined, selection: () => [] },
  });
  return { fake, reporter, run: (id: string, ...args: unknown[]) => present(handlers.get(id), `the handler for "${id}"`)(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
});

describe('check for updates, from a view', () => {
  it('checks the selected mods and reads the instance again once they are written', async () => {
    const { fake, run } = await register();

    await run(CHECK, modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(fake.calls).toEqual(checked('ModA', 'ModB'));
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'Instance loader: read every file again', 'progress closes']);
  });

  it('checks every mod from the Mods title bar', async () => {
    const { fake, run } = await register();

    await run('modbench.modList.checkForUpdatesHere');

    expect(fake.calls).toEqual(checked('ModA', 'ModB'));
  });

  it('says in one line how many mods have an update, and names each mod it could not ask about in the Output', async () => {
    const { reporter, run } = await register({ answers: { nexusFiles: new Map([['ModA', onNexus('1')]]), updatable: new Set(['ModA']) } });

    await run(CHECK, modRow('ModA'), [modRow('ModA'), modRow('ModB'), folderRow]);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Check for updates: 1 mod has an update, 2 could not be asked about.',
      detail: '"ModB" (it has no Nexus mod ID)\n"meshes" (it is not a mod or a separator)',
    }]);
  });

  it('lands the line when every mod could be asked about', async () => {
    const { reporter, run } = await register();

    await run(CHECK, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect([reporter.landings, reporter.reports]).toEqual([['Check for updates: 2 mods have an update, 0 could not be asked about.'], []]);
  });

  it('reports a refusal of the whole selection as an error', async () => {
    const { reporter, run } = await register({ loggedIn: false });

    await run(CHECK, modRow('ModA'));

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'You are not logged in to Nexus.', detail: undefined }]);
  });
});

describe('check for updates, on a separator', () => {
  const separatorRow = { argument: { kind: 'separator', name: 'Weapons' }, name: 'Weapons' };

  it('checks the mods the separator holds, and not the separator', async () => {
    const { fake, run } = await register();

    await run(CHECK, separatorRow, [separatorRow]);

    expect(fake.calls).toEqual(checked('ModA'));
  });

  it('runs under the Mods view when no row is selected', async () => {
    const { run } = await register();

    await run(CHECK);

    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
  });
});

describe('check for updates, from an agent', () => {
  it('checks every mod when the call names none, and answers the outcome', async () => {
    const { fake, run } = await register({ answers: { nexusFiles: new Map([['ModA', onNexus('1')]]), updatable: new Set(['ModA']) } });

    const answer = await run(CHECK, new AgentCall([], {}));

    expect({ answer, written: fake.calls }).toEqual({
      answer: { applied: true, outcome: { landed: [{ name: 'ModA', updateAvailable: true }], refused: [{ item: { name: 'ModB' }, reason: 'it has no Nexus mod ID' }] } },
      written: checked('ModA'),
    });
  });

  it('answers a refusal of the whole call as a refusal', async () => {
    const { run } = await register({ loggedIn: false });

    expect(await run(CHECK, new AgentCall([], {}))).toEqual({ applied: false, refusal: 'You are not logged in to Nexus.' });
  });
});
