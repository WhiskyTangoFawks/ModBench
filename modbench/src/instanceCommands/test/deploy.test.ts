import { describe, expect, it } from 'vitest';
import type { Deployed, Deployment, Purged, FileTheGameGets, PluginOrder } from '../../deployment/deployment';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { deployCommands, type DeploymentFolderSetting, type LoadOrderToDeploy } from '../deploy';

const NOT_IN_GAME = { gameFolderOverlapping: (folder: string) => Promise.resolve(folder.startsWith('/games/Fallout4') || folder === '/games' ? '/games/Fallout4' : undefined) };
const NO_MOVES = { moveIntoOverwrite: () => Promise.resolve(undefined), ...NOT_IN_GAME };
const SETTING_ID = 'modbench.deployment.folder';
const FILES: FileTheGameGets[] = [{ relativePath: 'a.esp', winner: '/instance/mods/Mod/a.esp' }];
const LOAD: LoadOrderToDeploy = { files: FILES, plugins: [], gameName: 'Fallout 4' };

function settingHolding(held: { workspaceValue?: string; globalValue?: string } | undefined): DeploymentFolderSetting {
  return { id: SETTING_ID, inspect: () => held };
}

const PURGED: Purged = { wrote: true, restored: '/local/plugins.txt', left: ['/local/plugins.txt.modbench_renamed'], leftAside: [] };

function deploymentAnswering(answer: () => Promise<Deployed>) {
  const purgedFrom: string[] = [];
  const deployedTo: [string, FileTheGameGets[], PluginOrder][] = [];
  const deployment: Deployment = {
    deploy: (folder, files, plugins) => {
      deployedTo.push([folder, [...files], plugins]);
      return answer();
    },
    purge: (folder) => {
      purgedFrom.push(folder);
      return Promise.resolve(PURGED);
    },
    unmanaged: () => Promise.resolve(['Data/current.ini']),
  };
  return { deployment, deployedTo, purgedFrom };
}

const landed = (): Promise<Deployed> => Promise.resolve({ wrote: true, leftOut: [{ path: 'Data/mine.ini', winner: '/instance/mods/Mod/mine.ini' }], unmanaged: ['Data/mine.ini'], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] } });

describe('deploy', () => {
  it('deploys the load order to the workspace\'s deployment folder, and answers what deploy left out', async () => {
    const { deployment, deployedTo } = deploymentAnswering(landed);

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(LOAD);

    expect([result, deployedTo]).toEqual([{ applied: true, wrote: true, leftOut: [{ path: 'Data/mine.ini', winner: '/instance/mods/Mod/mine.ini' }], unmanaged: ['Data/mine.ini'], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] }, canMoveToOverwrite: true }, [['/deployed', FILES, { release: 'Fallout4', entries: [] }]]]);
  });

  it.each([
    ['is the game folder', '/games/Fallout4'],
    ['holds the game folder', '/games'],
    ['sits inside the game folder', '/games/Fallout4/Data'],
  ])('answers that moving to Overwrite does not apply when the deployment folder %s', async (_case, folder) => {
    const { deployment } = deploymentAnswering(landed);

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: folder }) }).deploy(LOAD);

    expect(result).toMatchObject({ applied: true, canMoveToOverwrite: false });
  });

  it('answers that moving to Overwrite does not apply when deploy manages every file', async () => {
    const { deployment } = deploymentAnswering(() => Promise.resolve({ wrote: false, leftOut: [], unmanaged: [], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] } }));

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(LOAD);

    expect(result).toMatchObject({ applied: true, canMoveToOverwrite: false });
  });

  it.each([
    ['holds no value', undefined],
    ['holds an empty value', { workspaceValue: '' }],
    ['holds only a user-level value, which every instance would share', { globalValue: '/deployed' }],
  ])('is refused, naming the setting, while the setting %s', async (_case, held) => {
    const { deployment, deployedTo } = deploymentAnswering(landed);

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding(held) }).deploy(LOAD);

    expect([result, deployedTo]).toEqual([{ applied: false, refusal: `No deployment folder: set ${SETTING_ID}.` }, []]);
  });

  it('is refused while the instance has not been read, so an empty load order removes nothing deploy wrote', async () => {
    const { deployment, deployedTo } = deploymentAnswering(landed);

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(undefined);

    expect([result, deployedTo]).toEqual([{ applied: false, refusal: 'The instance has not been read.' }, []]);
  });

  it('is refused with the reason the deployment cannot deploy', async () => {
    const { deployment } = deploymentAnswering(() => Promise.reject(new Error('The deployment folder /deployed does not exist.')));

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(LOAD);

    expect(result).toEqual({ applied: false, refusal: 'The deployment folder /deployed does not exist.' });
  });

  it('gives the deployment the plugin rows once for each line, in the order of their lines, with the release of the game', async () => {
    const { deployment, deployedTo } = deploymentAnswering(landed);
    const plugins = [
      { name: 'B.esp', line: 1, enabled: false },
      { name: 'A.esp', line: 0, enabled: true },
      { name: 'A.esp', line: 0, enabled: true },
      { name: 'Unlisted.esp', line: null, enabled: false },
    ];

    await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy({ ...LOAD, plugins });

    expect(deployedTo.map(([, , order]) => order)).toEqual([{ release: 'Fallout4', entries: [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: false }] }]);
  });
});

describe('move to Overwrite', () => {
  function moving(folder = '/deployed', gameRoot = '/games/Fallout4') {
    const fake = fakeInstanceAdapter(readingFixture({ gameFolder: { kind: 'found', root: gameRoot, dataFolder: `${gameRoot}/Data` } }), {});
    const commands = deployCommands({ adapter: fake.adapter, deployment: deploymentAnswering(landed).deployment, deploymentFolder: settingHolding({ workspaceValue: folder }) });
    return { adapter: fake, commands };
  }

  it('moves each file from its path in the deployment folder to the path the next deploy links it back from', async () => {
    const { adapter, commands } = moving();

    const result = await commands.moveToOverwrite(['Data/MCM/settings.ini', 'game.exe']);

    expect([result, adapter.calls]).toEqual([{ applied: true, wrote: true, left: [] }, [{ verb: 'moveIntoOverwrite', moves: [
      { from: '/deployed/Data/MCM/settings.ini', relativePath: 'MCM/settings.ini' }, { from: '/deployed/game.exe', relativePath: 'Root/game.exe' },
    ] }]]);
  });

  it('moves the files deploy does not manage now when none are named', async () => {
    const { adapter, commands } = moving();

    const result = await commands.moveToOverwrite();

    expect([result, adapter.calls]).toEqual([{ applied: true, wrote: true, left: [] }, [{ verb: 'moveIntoOverwrite', moves: [{ from: '/deployed/Data/current.ini', relativePath: 'current.ini' }] }]]);
  });

  it('leaves in the folder, and names, each file no mod file can land at the path of, and moves the rest', async () => {
    const { adapter, commands } = moving();

    const result = await commands.moveToOverwrite(['Data/.hidden', 'Data/Root/x.ini', 'Data/a.esp']);

    expect([result, adapter.calls]).toEqual([{ applied: true, wrote: true, left: ['Data/.hidden', 'Data/Root/x.ini'] }, [{ verb: 'moveIntoOverwrite', moves: [{ from: '/deployed/Data/a.esp', relativePath: 'a.esp' }] }]]);
  });

  it('is refused with the reason Overwrite gives', async () => {
    const adapter = { ...NOT_IN_GAME, moveIntoOverwrite: () => Promise.resolve('"a.esp" is already in Overwrite.') };
    const commands = deployCommands({ adapter, deployment: deploymentAnswering(landed).deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) });

    expect(await commands.moveToOverwrite(['Data/a.esp'])).toEqual({ applied: false, refusal: '"a.esp" is already in Overwrite.' });
  });

  it.each([
    ['is the game folder', '/games/Fallout4'],
    ['holds the game folder', '/games'],
    ['sits inside the game folder', '/games/Fallout4/Data'],
  ])('is refused, moving nothing, when the deployment folder %s', async (_case, folder) => {
    const { adapter, commands } = moving(folder);

    const result = await commands.moveToOverwrite(['Data/a.esp']);

    expect([result, adapter.calls]).toEqual([{ applied: false, refusal: `The deployment folder ${folder} is, holds or sits inside the game folder /games/Fallout4: moving the game's own files out of it would break the game.` }, []]);
  });

  it('moves from a deployment folder whose name is only the start of the game folder\'s', async () => {
    const { adapter, commands } = moving('/games/Fallout');

    await commands.moveToOverwrite(['Data/a.esp']);

    expect(adapter.calls).toEqual([{ verb: 'moveIntoOverwrite', moves: [{ from: '/games/Fallout/Data/a.esp', relativePath: 'a.esp' }] }]);
  });

  it('is refused, naming the setting, while the setting holds no value', async () => {
    const commands = deployCommands({ adapter: NO_MOVES, deployment: deploymentAnswering(landed).deployment, deploymentFolder: settingHolding(undefined) });

    expect(await commands.moveToOverwrite(['Data/a.esp'])).toEqual({ applied: false, refusal: `No deployment folder: set ${SETTING_ID}.` });
  });
});

describe('purge', () => {
  it('purges the workspace's deployment folder, and answers what it put back and left', async () => {
    const { deployment, purgedFrom } = deploymentAnswering(landed);

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).purge();

    expect([result, purgedFrom]).toEqual([{ applied: true, ...PURGED }, ['/deployed']]);
  });

  it('is refused, naming the setting, while the setting holds no value', async () => {
    const { deployment, purgedFrom } = deploymentAnswering(landed);

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding(undefined) }).purge();

    expect([result, purgedFrom]).toEqual([{ applied: false, refusal: `No deployment folder: set ${SETTING_ID}.` }, []]);
  });

  it('is refused with the reason the deployment cannot purge', async () => {
    const { deployment } = deploymentAnswering(landed);
    deployment.purge = () => Promise.reject(new Error('EBUSY: resource busy'));

    const result = await deployCommands({ adapter: NO_MOVES, deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).purge();

    expect(result).toEqual({ applied: false, refusal: 'EBUSY: resource busy' });
  });
});
