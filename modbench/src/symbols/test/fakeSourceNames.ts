import type { SourceNames } from '../sourceNames';

const NOWHERE = { start: 0, end: 0 };

/** Plugin source's names as mEdit answers them, answering only what a test gives it. */
export const sourceNames = (answers: Partial<SourceNames> = {}): SourceNames => ({
  recordAt: () => Promise.resolve(undefined),
  scriptAt: () => Promise.resolve(undefined),
  scriptsNamed: () => Promise.resolve([]),
  scriptsIn: () => Promise.resolve([]),
  fileAt: () => Promise.resolve(undefined),
  pathTypedAt: () => Promise.resolve(undefined),
  recordsOfferedAt: () => Promise.resolve(undefined),
  recordMemberAt: () => Promise.resolve(undefined),
  declarationIn: () => Promise.resolve(undefined),
  formKeyIn: () => Promise.resolve(undefined),
  referenceIn: () => Promise.resolve(NOWHERE),
  pluginNamesIn: () => Promise.resolve([NOWHERE]),
  membersIn: () => Promise.resolve([]),
  ...answers,
});

/** The span of the first `spelled` in `text`; undefined where the text holds none. */
export const spelledIn = (text: string, spelled: string): { start: number; end: number } | undefined => {
  const start = text.indexOf(spelled);
  return start < 0 ? undefined : { start, end: start + spelled.length };
};
