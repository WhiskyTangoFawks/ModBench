import type { RecordWriteMarks } from '../editor/recordLifecycleCommands';

const unmarked = { answered: () => undefined, unanswered: () => undefined };

/** Marks no view shows, for a test of something else. */
export const noRecordWriteMarks: RecordWriteMarks = {
  deleting: () => unmarked,
  copying: () => unmarked,
};
