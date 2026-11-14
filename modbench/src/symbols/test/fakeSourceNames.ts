import type { PluginSourceNames } from '../../client';

/** Plugin source's names, answering only what a test gives it. */
export const sourceNames = (answers: Partial<PluginSourceNames> = {}): PluginSourceNames => ({
  recordAt: () => undefined,
  pluginAt: () => Promise.resolve(undefined),
  scriptAt: () => Promise.resolve(undefined),
  fileAt: () => Promise.resolve(undefined),
  recordsOfferedAt: () => Promise.resolve(undefined),
  recordMemberAt: () => undefined,
  ...answers,
});
