import type { Reporter, Severity } from '../ports/reporter';

/** `notify`: the view now shows something untrue (common.md, Reporting), so the line is a notification, told whenever its caller says. */
export interface Told { key: string; message: string; why: string; notify?: boolean }

/** Shows each told line on the surface once, and again only when its reason changes; a key absent from `standing` is forgotten. */
export function tellingOnSurface(reporter: Pick<Reporter, 'report' | 'shownOnSurface'>, severity: Severity): (standing: Told[]) => void {
  let told = new Map<string, string>();
  return (standing) => {
    for (const { key, message, why, notify } of standing) {
      if (notify === true) reporter.report(severity, message, why);
      else if (told.get(key) !== why) reporter.shownOnSurface(severity, message, why);
    }
    told = new Map(standing.map(({ key, why }) => [key, why]));
  };
}
