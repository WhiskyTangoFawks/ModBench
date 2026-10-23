// Which filenames are plugins.

import { extname } from 'node:path';

export const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

/** A filename's extension, lowercased, `''` for none. */
export const fileExtension = (name: string): string => extname(name).toLowerCase();

/** Whether a path sits at its origin's root, where plugins live, so a nested file sharing a
 *  plugin's name never matches one. */
export const isRootLevel = (relativePath: string): boolean => !relativePath.includes('/');

/** Whether a filename carries a plugin extension (case-insensitive). */
export const isPluginFile = (name: string): boolean => PLUGIN_EXTENSIONS.has(fileExtension(name));

/** Whether a path is a plugin where the game loads one from: at its origin's root. */
export const isPluginAtRoot = (relativePath: string): boolean => isRootLevel(relativePath) && isPluginFile(relativePath);
