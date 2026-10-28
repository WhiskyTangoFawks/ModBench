import { describe, expect, it } from 'vitest';
import type { Deployed, Deployment, FileTheGameGets, PluginOrder } from '../../deployment/deployment';
import { deployCommands, type DeploymentFolderSetting, type LoadOrderToDeploy } from '../deploy';

const SETTING_ID = 'modbench.deployment.folder';
const FILES: FileTheGameGets[] = [{ relativePath: 'a.esp', winner: '/instance/mods/Mod/a.esp' }];
const LOAD: LoadOrderToDeploy = { files: FILES, plugins: [], gameName: 'Fallout 4' };

function settingHolding(held: { workspaceValue?: string; globalValue?: string } | undefined): DeploymentFolderSetting {
  return { id: SETTING_ID, inspect: () => held };
}

function deploymentAnswering(answer: () => Promise<Deployed>) {
  const deployedTo: [string, FileTheGameGets[], PluginOrder][] = [];
  const deployment: Deployment = {
    deploy: (folder, files, plugins) => {
      deployedTo.push([folder, [...files], plugins]);
      return answer();
    },
  };
  return { deployment, deployedTo };
}

const landed = (): Promise<Deployed> => Promise.resolve({ wrote: true, leftOut: ['Data/mine.ini'], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] } });

describe('deploy', () => {
  it('deploys the load order to the workspace\'s deployment folder, and answers what deploy left out', async () => {
    const { deployment, deployedTo } = deploymentAnswering(landed);

    const result = await deployCommands({ deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(LOAD);

    expect([result, deployedTo]).toEqual([{ applied: true, wrote: true, leftOut: ['Data/mine.ini'], lost: [], leftAside: [], pluginsTxt: { kind: 'unchanged', renamed: [] } }, [['/deployed', FILES, { release: 'Fallout4', entries: [] }]]]);
  });

  it.each([
    ['holds no value', undefined],
    ['holds an empty value', { workspaceValue: '' }],
    ['holds only a user-level value, which every instance would share', { globalValue: '/deployed' }],
  ])('is refused, naming the setting, while the setting %s', async (_case, held) => {
    const { deployment, deployedTo } = deploymentAnswering(landed);

    const result = await deployCommands({ deployment, deploymentFolder: settingHolding(held) }).deploy(LOAD);

    expect([result, deployedTo]).toEqual([{ applied: false, refusal: `No deployment folder: set ${SETTING_ID}.` }, []]);
  });

  it('is refused while the instance has not been read, so an empty load order removes nothing deploy wrote', async () => {
    const { deployment, deployedTo } = deploymentAnswering(landed);

    const result = await deployCommands({ deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(undefined);

    expect([result, deployedTo]).toEqual([{ applied: false, refusal: 'The instance has not been read.' }, []]);
  });

  it('is refused with the reason the deployment cannot deploy', async () => {
    const { deployment } = deploymentAnswering(() => Promise.reject(new Error('The deployment folder /deployed does not exist.')));

    const result = await deployCommands({ deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy(LOAD);

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

    await deployCommands({ deployment, deploymentFolder: settingHolding({ workspaceValue: '/deployed' }) }).deploy({ ...LOAD, plugins });

    expect(deployedTo.map(([, , order]) => order)).toEqual([{ release: 'Fallout4', entries: [{ name: 'A.esp', enabled: true }, { name: 'B.esp', enabled: false }] }]);
  });
});
