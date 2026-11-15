import type { WatcherExclude } from '../instanceAdapter/instanceAdapter';

/** `files.watcherExclude` as a test fixes it: the patterns it holds, and a change it never signals. */
export const watcherExcluding = (patterns: Record<string, boolean> = {}): WatcherExclude => ({ value: () => patterns, changed: () => ({ dispose: () => {} }) });
