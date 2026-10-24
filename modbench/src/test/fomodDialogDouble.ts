import type { FomodAnswer, FomodDialog } from '../instanceAdapter/instanceAdapter';

export const FOMOD_PAGE: FomodDialog = {
  show: () => undefined, onMove: () => undefined, confirmMissing: () => Promise.resolve(true), asking: () => undefined, close: () => undefined,
};

/** What a view install answers a FOMOD's installer with. */
export const VIEW_ANSWER: FomodAnswer = { kind: 'dialog', dialog: FOMOD_PAGE };
