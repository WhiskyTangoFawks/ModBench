import type { Reporter, Severity } from '../ports/reporter';

export interface Told { key: string; message: string; why: string }

/** Shows each told line on the surface once, and again only when its reason changes; a key absent from `standing` is forgotten. */
export function tellingOnSurface(reporter: Pick<Reporter, 'shownOnSurface'>, severity: Severity): (standing: Told[]) => void {
  let told = new Map<string, string>();
  return (standing) => {
    for (const { key, message, why } of standing) if (told.get(key) !== why) reporter.shownOnSurface(severity, message, why);
    told = new Map(standing.map(({ key, why }) => [key, why]));
  };
}
