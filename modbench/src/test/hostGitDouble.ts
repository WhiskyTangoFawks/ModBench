import type { HostGit, HostGitApi, HostGitRepository } from '../ports/repository';

const folderOf = (path: string): string => `uri:${path}`;
const pathOf = (folder: string): string => folder.slice('uri:'.length);
const noEvent = (): { dispose(): void } => ({ dispose: () => {} });

const apiWith = (api: Partial<HostGitApi<string>>): HostGitApi<string> =>
  ({ init: () => Promise.resolve({}), getRepository: () => null, onDidOpenRepository: noEvent, onDidCloseRepository: noEvent, ...api });

const hostOver = (api: () => HostGitApi<string>): HostGit<string> =>
  ({ extension: () => ({ activate: () => Promise.resolve({ getAPI: api }) }), folderOf, pathOf });

export const hostGitRecordingInits = (initedFolders: string[] = [], initAnswer: unknown = {}): HostGit<string> =>
  hostOver(() => apiWith({ init: (folder) => { initedFolders.push(folder); return Promise.resolve(initAnswer); } }));

export const hostGitFailingToActivate = (message: string): HostGit<string> => ({
  extension: () => ({ activate: () => Promise.reject(new Error(message)) }),
  folderOf,
  pathOf,
});

export const hostWithoutGit: HostGit<string> = { extension: () => undefined, folderOf, pathOf };

export const hostGitDisabled: HostGit<string> = hostOver(() => { throw new Error('Git model not found'); });

export const hostGitHoldingNone: HostGit<string> = hostOver(() => apiWith({}));

type Listeners<T> = Set<(value: T) => unknown>;

const eventOver = <T>(listeners: Listeners<T>) => (listener: (value: T) => unknown): { dispose(): void } => {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
};

const fire = <T>(listeners: Listeners<T>, value: T): void => {
  for (const listener of [...listeners]) listener(value);
};

export interface HeldRepository {
  readonly host: HostGit<string>;
  /** The commit git's HEAD names. VS Code's state shows it once its status has run. */
  head: string | undefined;
  readonly config: Map<string, string>;
  readonly configAsked: string[];
  failNextConfig(): void;
  statusRuns(): number;
  /** VS Code's status run, as its watcher starts one. */
  changed(): void;
  open(): void;
  close(): void;
  /** VS Code's git opening a repository at `root`, which is not this one. */
  openElsewhere(root: string): void;
}

/** VS Code's git over the repository at `root`, open unless `open` is false. */
export function hostGitHolding(root: string, { head, open = true }: { head?: string; open?: boolean } = {}): HeldRepository {
  const changes: Listeners<void> = new Set();
  const opens: Listeners<HostGitRepository<string>> = new Set();
  const closes: Listeners<HostGitRepository<string>> = new Set();
  let opened = open;
  let shown = head;
  let statusRuns = 0;
  let failing = false;
  const repositoryAt = (at: string): HostGitRepository<string> => ({
    rootUri: folderOf(at),
    state: {
      get HEAD() { return { commit: shown }; },
      onDidChange: eventOver(changes),
    },
    getConfig: (key) => {
      held.configAsked.push(key);
      if (failing) {
        failing = false;
        return Promise.reject(new Error('spawn git EAGAIN'));
      }
      return Promise.resolve(held.config.get(key) ?? '');
    },
    status: () => {
      statusRuns++;
      shown = held.head;
      fire(changes, undefined);
      return Promise.resolve();
    },
  });
  const repository = repositoryAt(root);
  const held: HeldRepository = {
    head,
    config: new Map(),
    configAsked: [],
    failNextConfig: () => { failing = true; },
    statusRuns: () => statusRuns,
    changed: () => { void repository.status(); },
    open: () => {
      opened = true;
      fire(opens, repository);
    },
    close: () => {
      opened = false;
      fire(closes, repository);
    },
    openElsewhere: (at) => { fire(opens, repositoryAt(at)); },
    host: hostOver(() => apiWith({
      getRepository: (folder) => (opened && pathOf(folder).startsWith(root) ? repository : null),
      onDidOpenRepository: eventOver(opens),
      onDidCloseRepository: eventOver(closes),
    })),
  };
  return held;
}
