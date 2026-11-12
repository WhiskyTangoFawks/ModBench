import type { MEditClient } from '../client';
import type { Reporter } from '../ports/reporter';
import type { ProblemOnFile, ProblemsByFile } from './sourceProblems';

export interface Position { line: number; character: number }

export function positionAt(text: string, offset: number): Position {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

export const lastRead = (why: string): string => `Showing the last good read: ${why}`;

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

/** A publisher for each feed named, each replacing only its own problems; `publish` gets every feed's together. */
export function mergedFeeds(publish: (problems: ProblemsByFile) => void): (feed: string) => (problems: ProblemsByFile) => void {
  const parts = new Map<string, ProblemsByFile>();
  return (feed) => (problems) => {
    parts.set(feed, problems);
    const merged = new Map<string, ProblemOnFile[]>();
    for (const part of parts.values()) for (const [file, onFile] of part) merged.set(file, [...merged.get(file) ?? [], ...onFile]);
    publish(merged);
  };
}
