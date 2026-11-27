import { createSourceLanguage } from '..';
import type { PathStanding } from '../pathProblems';
import type { FilesChanged } from '../../instanceLoader/filesChanged';
import type { InstanceSubscriber, InstanceValue } from '../../instanceLoader/instance';
import { CHECK_THE_DISK } from '../../instanceAdapter/instanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import { recordingReporter } from '../../test/surfacingDoubles';
import { host } from './vscodeHost';

type Deps = Parameters<typeof createSourceLanguage>[0];

export const RETRY_AFTER_MS = 1000;
export const LINKS_STATUS = 'modbench.sourceProblems';
export const PATHS_STATUS = 'modbench.sourcePaths';

export const sourceFolders: Deps['sourceFiles'] = (origin) => ({ file: (relativePath) => `/source/${origin}/${relativePath}` });

/** An instance whose value the test lands, telling every subscriber that anything changed. */
export function instanceHolding(value: InstanceValue) {
  const subscribers = new Set<InstanceSubscriber>();
  const instance = {
    value,
    subscribe: <K extends keyof InstanceValue>(subscriber: InstanceSubscriber<K>) => {
      const told: InstanceSubscriber = (next, sequence, heard) => subscriber(next, sequence, heard);
      subscribers.add(told);
      return { dispose: () => { subscribers.delete(told); } };
    },
    land: (next: InstanceValue) => {
      const before = instance.value;
      instance.value = next;
      for (const subscriber of [...subscribers]) void subscriber(next, 1, { ...CHECK_THE_DISK, before, changed: () => 'every' });
    },
  };
  return instance;
}

/** What the instance holds of the paths a plugin source names: judged, holding nothing, until the test says otherwise. */
export function pathStandingOf(over: Partial<PathStanding> = {}) {
  const listeners = new Set<(changed: FilesChanged) => void>();
  const standing: PathStanding = {
    judged: () => true, holds: () => false, triedPaths: (dataPath) => [dataPath.toLowerCase()],
    subscribe: (listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    ...over,
  };
  return { standing, changed: (changed: FilesChanged = 'every') => { for (const listener of [...listeners]) listener(changed); } };
}

interface Over extends Partial<Omit<Deps, 'client' | 'ask'>> {
  /** Scripts mEdit before the box first asks it. */
  arrange?: (client: InMemoryMEditClient) => void;
}

/** The Source language box in a fresh VS Code, over an mEdit that answers no problem and no path until scripted. */
export function sourceLanguageOver({ arrange, ...over }: Over = {}) {
  host.reset();
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginProblems', []);
  client.setQueryAnswer('getPluginFilePaths', []);
  arrange?.(client);
  const reporter = recordingReporter();
  const language = createSourceLanguage({
    client, ask: problemsAsker(client, RETRY_AFTER_MS), instance: undefined, sourceFiles: sourceFolders, reporter,
    pathStanding: pathStandingOf().standing, ...over,
  });
  const asked = (method: 'getPluginProblems' | 'getPluginFilePaths') => client.calls.filter((call) => call.method === method).map(({ args }) => args);
  /** The Problems panel's source problems, once both feeds answered every change heard. */
  const problems = async () => { await language.problemsCaughtUp(); return host.problems('modbench-source'); };
  return { client, reporter, language, asked, problems };
}
