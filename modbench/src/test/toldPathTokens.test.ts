import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';
import { Instance } from '../instanceLoader/instance';
import { writesToldTo } from '../repositoriesLib/writesTold';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';

vi.mock('vscode', () => fakeVscodeModule());


const made: string[] = [];
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  writesToldTo({ told: () => Promise.resolve({ subscribed: Promise.resolve() }) });
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function repositoryWithPathFilters() {
  const root = cloneCorpusFixture();
  made.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const adapter = adapterOver(root);
  await adapter.writePathTokens();
  instance = new Instance({
    adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    medit: new InMemoryMEditClient(), workspace: fakeWorkspace(),
  });
  writesToldTo(instance);
  return { adapter, instance };
}

describe('a write the Instance adapter tells the loader of, in a repository that holds path filters', () => {
  it('does not stop the loader\'s own reading from landing when the reading itself writes', async () => {
    const { instance: loader } = await repositoryWithPathFilters();

    await loader.refresh();

    expect(loader.readFailure).toBeUndefined();
    expect(loader.sequence).toBeGreaterThan(0);
  });

  it('does not wait on the loader reading while it holds the lock the reading takes', async () => {
    const { adapter, instance: loader } = await repositoryWithPathFilters();
    await loader.refresh();

    await adapter.writePathTokens();
  });
});
