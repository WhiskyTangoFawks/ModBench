import type { MEditClient, PluginAddress, PluginFilePaths, PluginProblems } from '../client';
import type { ProblemsAsker } from '../drivingLib/problemsAsker';
import { coalesced } from '../ports/coalesced';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from '../wire/pluginAddress';
import type { ProblemOnFile, ProblemsByFile } from './sourceProblems';

export type Asked = ProblemsAsker<PluginFilePaths, PluginProblems>;

export interface Position { line: number; character: number }

export function positionAt(text: string, offset: number): Position {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

export const lastRead = (why: string): string => `Showing the last good read: ${why}`;

/** What a feed does when told to ask again: the whole set, or the one plugin. */
export const askedAgain = (whole: () => void, one: (event: { plugin: PluginAddress }) => void) => (plugin?: PluginAddress): void => {
  if (plugin) one({ plugin }); else whole();
};

export interface Told { key: string; message: string; why: string }

/** Shows each told line on the surface once, and again only when its reason changes; a key absent from `standing` is forgotten. */
export function tellingOnSurface(reporter: Pick<Reporter, 'shownOnSurface'>): (standing: Told[]) => void {
  let told = new Map<string, string>();
  return (standing) => {
    for (const { key, message, why } of standing) if (told.get(key) !== why) reporter.shownOnSurface('warning', message, why);
    told = new Map(standing.map(({ key, why }) => [key, why]));
  };
}

type Lateness = Pick<MEditClient, 'recordIndexMayBeLate' | 'onDidChangeRecordIndexMayBeLate'>;

/** Asks of each plugin changed, and while the record index may be late holds the plugins named, to ask of exactly those when it is not. */
export function askingWhenNotLate(client: Lateness, ask: (plugin: PluginAddress) => void): { plugin: (event: { plugin: PluginAddress }) => void; stop: () => void } {
  const held = new Map<string, PluginAddress>();
  const subscription = client.onDidChangeRecordIndexMayBeLate((late) => {
    if (late) return;
    const named = [...held.values()];
    held.clear();
    for (const plugin of named) ask(plugin);
  });
  return {
    plugin: ({ plugin }) => { if (client.recordIndexMayBeLate) held.set(pluginAddressKey(plugin), plugin); else ask(plugin); },
    stop: () => { subscription.dispose(); },
  };
}

/** A publisher for each feed named, each replacing only its own problems; `publishFile` gets every feed's problems on a
 *  file together, and only for a file whose problems changed. A file whose problems went is published with none. */
export function mergedFeeds(publishFile: (file: string, problems: readonly ProblemOnFile[]) => void): (feed: string) => (problems: ProblemsByFile) => void {
  const parts = new Map<string, ProblemsByFile>();
  let shown = new Map<string, ProblemOnFile[]>();
  return (feed) => (problems) => {
    parts.set(feed, problems);
    const merged = new Map<string, ProblemOnFile[]>();
    for (const part of parts.values()) for (const [file, onFile] of part) merged.set(file, [...merged.get(file) ?? [], ...onFile]);
    for (const file of new Set([...shown.keys(), ...merged.keys()])) {
      const now = merged.get(file) ?? [];
      if (JSON.stringify(now) !== JSON.stringify(shown.get(file) ?? [])) publishFile(file, now);
    }
    shown = merged;
  };
}

/** `settled` resolves once every change heard has its answer published. */
export interface Feed { stop: () => void; settled: () => Promise<void> }

export interface Settling {
  /** Makes the function a change calls: one `body` run follows the calls of a turn, and never two at once. */
  asking: (body: () => Promise<void>) => () => void;
  working: <T>(run: () => Promise<T>) => Promise<T>;
  /** Resolves once no call is unanswered and no work runs. */
  settled: () => Promise<void>;
}

export function settling(): Settling {
  let requests = 0;
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => { if (requests === 0 && running === 0) for (const resume of waiting.splice(0)) resume(); };
  const working = async <T>(run: () => Promise<T>): Promise<T> => {
    running += 1;
    try { return await run(); } finally { running -= 1; release(); }
  };
  return {
    asking: (body) => {
      const run = coalesced(() => {
        const taken = requests;
        return working(async () => { try { await body(); } finally { requests -= taken; } });
      });
      return () => { requests += 1; run(); };
    },
    working,
    settled: () => (requests === 0 && running === 0 ? Promise.resolve() : new Promise<void>((resume) => { waiting.push(resume); })),
  };
}
