import type { HostGit } from '../../ports/repository';

const folderOf = (path: string): string => `uri:${path}`;

export const hostGitRecordingInits = (initedFolders: string[] = [], initAnswer: unknown = {}): HostGit<string> => ({
  extension: () => ({ activate: () => Promise.resolve({ getAPI: () => ({ init: (folder) => { initedFolders.push(folder); return Promise.resolve(initAnswer); } }) }) }),
  folderOf,
});

export const hostGitFailingToActivate = (message: string): HostGit<string> => ({
  extension: () => ({ activate: () => Promise.reject(new Error(message)) }),
  folderOf,
});

export const hostWithoutGit: HostGit<string> = { extension: () => undefined, folderOf };
