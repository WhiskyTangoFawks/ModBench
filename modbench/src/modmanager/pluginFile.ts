// Which filenames are plugins. Nothing here opens one: the extension parses no plugin binary
// (ADR-0016), and every fact about a plugin's contents comes from the backend.

import { extname } from 'node:path';

/** Creation Engine plugin extensions — FO4, SSE and Starfield share these, so this is not
 *  an FO4 lock. */
export const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

/** Whether a filename carries a plugin extension (case-insensitive). */
export const isPluginFile = (name: string): boolean => PLUGIN_EXTENSIONS.has(extname(name).toLowerCase());
