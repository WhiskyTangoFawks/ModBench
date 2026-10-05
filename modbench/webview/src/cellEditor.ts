import { createContext } from 'react';

export const EditorMounted = createContext<(editor: HTMLElement | null) => void>(() => undefined);
