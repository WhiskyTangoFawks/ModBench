import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { separatorCarrier } from './sourceGestureHarness';
import { file, folder, indexedValueOf } from './indexedValue';
import { progressSteps } from '../../test/recordedProgress';
import { AgentCall } from '../../drivingLib/agentGesture';
import { checkForUpdatesOver } from '../../modCommands/checkForUpdates';
import { fakeInstanceAdapter, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';

const CHECK = 'modbench.mod.checkForUpdates';

const MOD_FOLDERS = [
  { kind: 'mod' as const, name: 'ModA', path: '/instance/mods/ModA', modName: 'ModA' },
  { kind: 'separator' as const, name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' },
  { kind: 'mod' as const, name: 'ModB', path: '/instance/mods/ModB', modName: 'ModB' },
];

const onNexus = (modId: string) => ({ kind: 'read', answer: { game: 'fallout4', modId, fileId: '1', fileName: undefined, fileStatus: undefined } } as const);
const ON_NEXUS: InstanceAnswers = { nexusFiles: new Map([['ModA', onNexus('1')], ['ModB', onNexus('2')]]), updatable: new Set(['ModA', 'ModB']) };
const NEWEST = '2.0';
const checked = (...mods: string[]): AdapterCall[] => mods.map((mod) => ({ verb: 'writeNewestVersion', mod, version: NEWEST }));

async function register({ answers = ON_NEXUS, loggedIn = true }: { answers?: InstanceAnswers; loggedIn?: boolean } = {}) {
  const fake = fakeInstanceAdapter(undefined, answers);
  const nexus = { loggedIn: () => Promise.resolve(loggedIn), newestVersion: () => Promise.resolve({ found: true, version: NEWEST } as const) };
  const value = await indexedValueOf(
    [{ kind: 'mod', name: 'ModA', enabled: true }, { kind: 'separator', name: 'Weapons', enabled: true }, { kind: 'mod', name: 'ModB', enabled: false }],
    { ModA: { files: [file('ModA', 'meshes/a.nif')], folders: [folder('ModA', 'meshes')] } },
  );
  const shown = modsViewOn({ value: { ...value, modFolders: MOD_FOLDERS }, adapter: fake, checkForUpdates: checkForUpdatesOver(fake.adapter, nexus) });
  const modA = async () => shown.row('ModA', await shown.row('Weapons'));
  const folderRow = async () => shown.row('meshes', await modA());
  return { ...shown, fake, modA, folderRow };
}

describe('check for updates, from a view', () => {
  it('checks the selected mods and reads the instance again once they are written', async () => {
    const { fake, run, modA, row } = await register();

    await run(CHECK, await row('ModB'), [await modA(), await row('ModB')]);

    expect(fake.calls).toEqual(checked('ModA', 'ModB'));
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'progress closes']);
  });

  it('checks every mod from the Mods title bar', async () => {
    const { fake, run } = await register();

    await run('modbench.modList.checkForUpdatesHere');

    expect(fake.calls).toEqual(checked('ModA', 'ModB'));
  });

  it('says in one line how many mods have an update, and names each mod it could not ask about in the Output', async () => {
    const { reporter, run, modA, row, folderRow } = await register({ answers: { nexusFiles: new Map([['ModA', onNexus('1')]]), updatable: new Set(['ModA']) } });

    await run(CHECK, await modA(), [await modA(), await row('ModB'), await folderRow()]);

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Check for updates: 1 mod has an update, 2 could not be asked about.',
      detail: '"ModB" (it has no Nexus mod ID)\n"meshes" (it is not a mod or a separator)',
    }]);
  });

  it('lands the line when every mod could be asked about', async () => {
    const { reporter, run, modA, row } = await register();

    await run(CHECK, await modA(), [await modA(), await row('ModB')]);

    expect([reporter.landings, reporter.reports]).toEqual([['Check for updates: 2 mods have an update, 0 could not be asked about.'], []]);
  });

  it('reports a refusal of the whole selection as an error', async () => {
    const { reporter, run, modA } = await register({ loggedIn: false });

    await run(CHECK, await modA());

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'You are not logged in to Nexus.', detail: undefined }]);
  });

});

describe('check for updates, on a separator', () => {
  it('checks the mods the separator holds, and not the separator', async () => {
    const { fake, run } = await register();

    await run(CHECK, separatorCarrier('Weapons'), [separatorCarrier('Weapons')]);

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
