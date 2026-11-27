import { downloadsDirectoryResolver } from './downloadsDirectory';
import { gameFolderResolver, steamInstallResolver } from '../gameFolder/gameFolderResolver';
import type { GameFolderSetting, Machine, WatcherExclude } from '../instanceAdapter';
import { myGamesResolver } from '../gameFolder/myGames';
import type { Mo2Context } from './mo2Context';
import { mo2Watch } from './mo2Watch';
import { repositoryReads } from '../repositoryReads';
import { programRunning } from '../processes';
import type { HostGit } from '../../ports/repository';

const MO2_PROGRAM = 'ModOrganizer.exe';

interface ContextParts {
  readonly instanceRoot: string;
  readonly gameFolderSetting: GameFolderSetting;
  readonly watcherExclude: WatcherExclude;
  readonly hostGit: HostGit<unknown>;
  readonly machine: Machine;
}

export function mo2Context({ instanceRoot, gameFolderSetting, watcherExclude, hostGit, machine }: ContextParts): Mo2Context {
  const repository = repositoryReads(instanceRoot, hostGit);
  return {
    instanceRoot,
    resolveGameFolder: gameFolderResolver(gameFolderSetting, machine),
    resolveSteamInstall: steamInstallResolver(machine),
    resolveDownloadsFolder: downloadsDirectoryResolver(machine),
    resolveMyGames: myGamesResolver(instanceRoot, machine),
    watch: mo2Watch(instanceRoot, gameFolderSetting.changed, repository.changed, watcherExclude),
    repository,
    mo2Running: () => programRunning(machine, MO2_PROGRAM),
  };
}
