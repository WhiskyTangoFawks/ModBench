import { describe, it, expect } from 'vitest';
import { checkForUpdatesOver } from '../checkForUpdates';
import type { NexusModFile } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, refusing, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { GOOD_KEY, nexusAnswering } from '../../nexus/test/nexusDouble';

const FILES = (modId: string): string => `https://api.nexusmods.com/v1/games/fallout4/mods/${modId}/files.json`;
const onNexus = (modId: string): NexusModFile => ({ game: 'fallout4', modId, fileId: '1', fileName: undefined, fileStatus: undefined });
const held = (modId: string) => ({ kind: 'read' as const, answer: onNexus(modId) });
const listing = (version: string): Response =>
  new Response(JSON.stringify({ files: [{ file_id: 1, version, category_id: 1, file_name: 'a.7z' }], file_updates: [] }), { status: 200 });

async function checking(mods: readonly string[], answers: InstanceAnswers, nexusSays: (url: string) => Response | Error, loggedIn = true) {
  const fake = fakeInstanceAdapter(undefined, answers);
  const { nexus } = nexusAnswering((_key, url) => nexusSays(url));
  if (loggedIn) await nexus.keep(GOOD_KEY);
  return { fake, result: await checkForUpdatesOver(fake.adapter, nexus)(mods) };
}

describe('check for updates', () => {
  it('writes the newest version Nexus names for each mod, and says which mods have an update', async () => {
    const answers = { nexusFiles: new Map([['A', held('1')], ['B', held('2')]]), updatable: new Set(['B']) };

    const { fake, result } = await checking(['A', 'B'], answers, (url) => listing(url === FILES('1') ? '1.0' : '2.0'));

    expect(result).toEqual({ applied: true, outcome: { landed: [{ name: 'A', updateAvailable: false }, { name: 'B', updateAvailable: true }], refused: [] } });
    expect(fake.calls).toEqual([{ verb: 'writeNewestVersion', mod: 'A', version: '1.0' }, { verb: 'writeNewestVersion', mod: 'B', version: '2.0' }]);
  });

  it('leaves a mod with no Nexus mod ID as it was, and refuses it by name', async () => {
    const { fake, result } = await checking(['Local'], {}, () => new Error('never asked'));

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'Local' }, reason: 'it has no Nexus mod ID' }] } });
    expect(fake.calls).toEqual([]);
  });

  it('leaves a mod whose metadata cannot say where it is as it was', async () => {
    const answers = { nexusFiles: new Map([['Odd', { kind: 'unreadable' as const, reason: 'Nexus has no game for Nowhere' }]]) };

    const { fake, result } = await checking(['Odd'], answers, () => new Error('never asked'));

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'Odd' }, reason: 'Nexus has no game for Nowhere' }] } });
    expect(fake.calls).toEqual([]);
  });

  it('leaves a mod Nexus refuses as it was, and checks the others', async () => {
    const answers = { nexusFiles: new Map([['Gone', held('1')], ['Held', held('2')]]) };

    const { fake, result } = await checking(['Gone', 'Held'], answers, (url) => (url === FILES('1') ? new Response('', { status: 404 }) : listing('2.0')));

    expect(result).toEqual({
      applied: true, outcome: { landed: [{ name: 'Held', updateAvailable: false }], refused: [{ item: { name: 'Gone' }, reason: 'Nexus does not hold this mod.' }] },
    });
    expect(fake.calls).toEqual([{ verb: 'writeNewestVersion', mod: 'Held', version: '2.0' }]);
  });

  it('refuses a mod whose metadata cannot be written', async () => {
    const answers = { nexusFiles: new Map([['A', held('1')]]), refusals: refusing('writeNewestVersion', 'EACCES: permission denied') };

    const { result } = await checking(['A'], answers, () => listing('1.0'));

    expect(result).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: { name: 'A' }, reason: 'EACCES: permission denied' }] } });
  });

  it('asks Nexus nothing and refuses the whole selection while logged out', async () => {
    const answers = { nexusFiles: new Map([['A', held('1')]]) };

    const { fake, result } = await checking(['A'], answers, () => new Error('never asked'), false);

    expect(result).toEqual({ applied: false, refusal: 'You are not logged in to Nexus.' });
    expect(fake.calls).toEqual([]);
  });
});
