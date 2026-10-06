// Which filenames are plugins. Nothing here opens one (ADR-0016).

import { extname } from 'node:path';

export const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

/** A filename's extension, lowercased, `''` for none. */
export const fileExtension = (name: string): string => extname(name).toLowerCase();

/** Whether a filename carries a plugin extension (case-insensitive). */
export const isPluginFile = (name: string): boolean => PLUGIN_EXTENSIONS.has(fileExtension(name));
