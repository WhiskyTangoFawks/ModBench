import type { MEditClient, PluginAddress, PluginFilePaths, PluginProblems } from '../client';
import type { ProblemsAsker } from '../drivingLib/problemsAsker';
import type { Reporter } from '../ports/reporter';
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

/** Whether mEdit's record index answers: once the load order settles, and before any status, once an ask was answered. */
export function readiness(client: Pick<MEditClient, 'loadOrderStatus'>): { ready: () => boolean; answeredAtSubscribe: () => void } {
  let answered = false;
  return { ready: () => client.loadOrderStatus?.conflictsComputed ?? answered, answeredAtSubscribe: () => { answered = true; } };
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

export interface Settling {
  /** A change calls for an ask. */
  requested: () => void;
  /** Runs the ask that takes every request made before it began. */
  answering: <T>(run: () => Promise<T>) => Promise<T>;
  working: <T>(run: () => Promise<T>) => Promise<T>;
  /** Resolves once no request is unanswered and no work runs. */
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
    requested: () => { requests += 1; },
    answering: (run) => {
      const taken = requests;
      return working(async () => { try { return await run(); } finally { requests -= taken; } });
    },
    working,
    settled: () => (requests === 0 && running === 0 ? Promise.resolve() : new Promise<void>((resume) => { waiting.push(resume); })),
  };
}
