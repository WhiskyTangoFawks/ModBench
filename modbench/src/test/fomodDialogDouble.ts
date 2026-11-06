import type { FomodAnswer, FomodDialog } from '../instanceAdapter/instanceAdapter';

export const FOMOD_PAGE: FomodDialog = {
  show: () => undefined, onMove: () => undefined, confirmMissing: () => Promise.resolve(true), refuse: () => Promise.resolve('manual'), asking: () => undefined, close: () => undefined,
};

/** What a view install answers a FOMOD's installer with. */
export const VIEW_ANSWER: FomodAnswer = { kind: 'dialog', dialog: FOMOD_PAGE, steps: [] };

/** A page that answers a refusal as given, recording what the install asked of it. */
export function refusingPage(answer: 'manual' | 'cancelled'): { readonly dialog: FomodDialog; readonly events: string[] } {
  const events: string[] = [];
  const dialog: FomodDialog = {
    ...FOMOD_PAGE,
    asking: (asking) => { events.push(`asking ${asking}`); },
    refuse: (why) => { events.push(`refuse: ${why}`); return Promise.resolve(answer); },
  };
  return { dialog, events };
}
