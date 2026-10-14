import type { LoadOrderWire } from './loadOrderSender';

/** What an adapter gives the hand-over: its process, its stream's reopen, and one PUT of the language,
 *  which tells its own failure. */
export type StringsLanguageWire = Pick<LoadOrderWire, 'status' | 'onStatusChanged' | 'onReconnected'> & {
  put(language: string): Promise<void>;
};

export interface StringsLanguageHandOver {
  hand(language: string): void;
}

/** Puts each language at once and in order while mEdit runs, and the newest again whenever the
 *  process behind the wire may hold none. */
export function createStringsLanguageHandOver(wire: StringsLanguageWire): StringsLanguageHandOver {
  let newest: string | undefined;
  let sending = Promise.resolve();
  const put = (language: string): void => { sending = sending.then(() => wire.put(language)); };
  const putNewest = (): void => { if (newest !== undefined) put(newest); };
  wire.onStatusChanged((status) => { if (status === 'running') putNewest(); });
  wire.onReconnected(putNewest);
  return {
    hand: (language) => {
      newest = language;
      if (wire.status() === 'running') put(language);
    },
  };
}
