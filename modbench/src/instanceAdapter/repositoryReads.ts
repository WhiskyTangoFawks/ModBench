import { join, resolve } from 'node:path';
import type { HostGit, HostGitApi, HostGitRepository } from '../ports/repository';
import { pathKey } from '../repositoriesLib/stampedReads';
import { GIT_DIR, keptUntilNamed } from './files';
import { git } from './git';
import type { Subscription } from './instanceAdapter';

/** The instance repository's reads, from VS Code's git where its API answers them and from git elsewhere, kept until a
 *  check of the disk or a change that names the repository's .git or a file in it. */
export interface RepositoryReads {
  /** The commit HEAD names; undefined on a branch that has none. */
  readonly head: () => Promise<string | undefined>;
  /** The repository's own value of `key`, '' where it has none. */
  readonly localConfig: (key: string) => Promise<string>;
  /** What git answers, trimmed; '' where git exits 1, as `config --get` does for a key that is not set. */
  readonly git: (...args: string[]) => Promise<string>;
  /** Calls `listener` with the repository's HEAD, the path a reading names to read these answers again, when VS Code's git
   *  says the repository changed. Its state then holds the change, so that reading runs no status. */
  readonly changed: (listener: (path: string) => void) => Subscription;
}

const exitedWith1 = (err: unknown): boolean => typeof err === 'object' && err !== null && 'code' in err && err.code === 1;

const gitOrNothing = (root: string, args: readonly string[]): Promise<string> =>
  git(root, ...args).then((answer) => answer.trim(), (err: unknown) => {
    if (exitedWith1(err)) return '';
    throw err;
  });

type Repository<Folder> = HostGitRepository<Folder>;

export function repositoryReads<Folder>(root: string, host: HostGit<Folder>): RepositoryReads {
  const dotGit = join(root, GIT_DIR);
  let acquired: Promise<HostGitApi<Folder> | undefined> | undefined;
  const api = (): Promise<HostGitApi<Folder> | undefined> => (acquired ??= (async () => {
    try {
      return (await host.extension()?.activate())?.getAPI(1);
    } catch {
      return undefined;
    }
  })());
  // VS Code's git answers a path inside a repository it holds with that repository, though git finds the instance's own.
  const isInstances = (repository: Repository<Folder>): boolean => pathKey(resolve(host.pathOf(repository.rootUri))) === pathKey(resolve(root));
  const repositoryIn = (held: HostGitApi<Folder> | undefined): Repository<Folder> | undefined => {
    const repository = held?.getRepository(host.folderOf(root)) ?? undefined;
    return repository !== undefined && isInstances(repository) ? repository : undefined;
  };
  const answers = keptUntilNamed(() => Promise.resolve(new Map<string, Promise<string>>()));
  // Kept under the index, which Modbench's own git writes name, through the .git, and VS Code's change does not. VS Code's
  // change during its status run here is no news.
  const statusKey = join(dotGit, 'index');
  let running = false;
  const statusRun = keptUntilNamed(async () => {
    running = true;
    try {
      await repositoryIn(await api())?.status();
    } finally {
      running = false;
    }
  });

  const kept = async (key: string, read: (repository: Repository<Folder> | undefined) => PromiseLike<string>): Promise<string> => {
    const repository = repositoryIn(await api());
    const answered = await answers(dotGit);
    const held = answered.get(key);
    if (held !== undefined) return held;
    const answer = Promise.resolve(read(repository));
    answered.set(key, answer);
    void answer.catch(() => {
      if (answered.get(key) === answer) answered.delete(key);
    });
    return answer;
  };

  return {
    // VS Code's state shows HEAD as of its latest status run, which a check of the disk cannot wait for.
    head: async () => {
      const repository = repositoryIn(await api());
      if (repository === undefined) return (await kept('head', () => gitOrNothing(root, ['rev-parse', '-q', '--verify', 'HEAD']))) || undefined;
      await statusRun(statusKey);
      return repository.state.HEAD?.commit;
    },
    localConfig: (key) => kept(`config ${key}`, (repository) => repository?.getConfig(key) ?? gitOrNothing(root, ['config', '--local', '--get', key])),
    git: (...args) => kept(args.join('\0'), () => gitOrNothing(root, args)),
    changed: (listener) => {
      const heard = (): void => {
        if (!running) listener(join(dotGit, 'HEAD'));
      };
      let stopped = false;
      let following: { dispose(): unknown }[] = [];
      let state: { dispose(): unknown } | undefined;
      const follow = (repository: Repository<Folder> | undefined): void => {
        state?.dispose();
        state = repository?.state.onDidChange(heard);
      };
      const ifInstances = (then: (repository: Repository<Folder>) => void) => (repository: Repository<Folder>): void => {
        if (!isInstances(repository)) return;
        then(repository);
        heard();
      };
      void api().then((held) => {
        if (stopped || held === undefined) return;
        following = [held.onDidOpenRepository(ifInstances(follow)), held.onDidCloseRepository(ifInstances(() => { follow(undefined); }))];
        follow(repositoryIn(held));
      });
      return {
        dispose: () => {
          stopped = true;
          for (const subscription of following) subscription.dispose();
          state?.dispose();
        },
      };
    },
  };
}
