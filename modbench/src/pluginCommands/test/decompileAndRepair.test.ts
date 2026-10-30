import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, readingFixture, sourceModsOf } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { MEditClient } from '../../client';

const MALFORMED = { name: 'Malformed.esp', origin: 'Harbor' };
const REFUSED = { item: { name: 'Clean.esp', origin: 'Harbor' }, reason: 'Clean.esp is not malformed.' };
const MADE = { folder: '/instance/mods/Harbor', repository: { sourceFolder: '/source/Harbor', assets: ['a.dds'], buildFile: '{}' } };

describe('decompileAndRepair — one send, a mod with no repository handed the one decompile and commit makes', () => {
  let client: InMemoryMEditClient;
  let made: typeof MADE | { refusal: string };
  let removed: string[];
  let notRemoved: string | undefined;
  const repairIn = (sourceMods: Record<string, string>, force = false) => {
    const newRepositories = {
      of: (mod: string) => Promise.resolve(mod === 'Harbor' ? made : { refusal: 'unasked' }),
      folderManifestRemovedOrWhy: ({ folder }: { folder: string }) => { removed.push(folder); return Promise.resolve(notRemoved); },
    };
    return pluginCommandsWith(fakeInstanceAdapter(readingFixture({ sourceMods: sourceModsOf(sourceMods) })).adapter, client, newRepositories)
      .decompileAndRepair([MALFORMED], force);
  };
  const sent = () => client.calls.filter((call) => call.method === 'decompileAndRepair').map((call) => call.args);
  const landingEach: MEditClient['decompileAndRepair'] = (plugins) => Promise.resolve({
    landed: plugins.map(({ plugin }) => plugin),
    refused: [REFUSED],
  });

  beforeEach(() => {
    client = new InMemoryMEditClient();
    client.setCommandHandler('decompileAndRepair', landingEach);
    made = MADE;
    removed = [];
    notRemoved = undefined;
  });

  it('repairs each plugin with no preview, a mod with no repository handed the one decompile and commit makes', async () => {
    expect(await repairIn({}, true)).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [REFUSED] } });
    expect(sent()).toEqual([[[{ plugin: MALFORMED, newRepository: MADE.repository }], true]]);
    expect(removed).toEqual([MADE.folder]);
  });

  it('hands a mod a repository builds no new one, and removes no manifest of its folder', async () => {
    await repairIn({ Harbor: '/source/Harbor' }, true);

    expect(sent()).toEqual([[[{ plugin: MALFORMED }], true]]);
    expect(removed).toEqual([]);
  });

  it('sends the force it was given', async () => {
    await repairIn({ Harbor: '/source/Harbor' }, false);

    expect(sent().map(([, force]) => force)).toEqual([false]);
  });

  it('refuses a plugin whose mod has no repository and cannot be given one, naming why, and repairs nothing for it', async () => {
    made = { refusal: 'its metadata could not be read: EACCES' };

    const outcome = await repairIn({}, true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: MALFORMED, reason: 'Harbor has no repository, and one cannot be made: its metadata could not be read: EACCES' }] } });
    expect(sent()).toEqual([]);
  });

  it('names a repaired plugin whose mod folder\'s manifest could not be removed once its repository was made', async () => {
    notRemoved = 'the manifest in its folder could not be removed: EACCES';

    const outcome = await repairIn({}, true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [MALFORMED], refused: [REFUSED, { item: MALFORMED, reason: `was repaired, but ${notRemoved}` }] } });
  });
});
