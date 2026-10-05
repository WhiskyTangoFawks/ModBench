import { createContext } from 'react';

/** The ref an in-place editor takes: the panel hears it open, as an element, and close, as null. */
export const EditorMounted = createContext<(editor: HTMLElement | null) => void>(() => undefined);
