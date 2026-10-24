import type { HostGit } from '../../ports/repository';

/** VS Code's git, answering each init with `made`, and recording the folder of each. */
export const hostGitMaking = (folders: string[] = [], made: unknown = {}): HostGit<string> => ({
  extension: () => ({ activate: () => Promise.resolve({ getAPI: () => ({ init: (folder) => { folders.push(folder); return Promise.resolve(made); } }) }) }),
  folderOf: (path) => `uri:${path}`,
});

/** VS Code's git, failing to start. */
export const hostGitFailing = (message: string): HostGit<string> => ({
  extension: () => ({ activate: () => Promise.reject(new Error(message)) }),
  folderOf: (path) => `uri:${path}`,
});
