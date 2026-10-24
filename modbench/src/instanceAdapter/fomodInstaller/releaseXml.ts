// A FOMOD's XML files as the reference installer reads them: UTF-8 with or without a byte order mark, or UTF-16 by
// its byte order mark. The text keeps its byte order mark.

import { readFile } from 'node:fs/promises';

const BOM = '\uFEFF';

async function decoded(decode: () => Promise<string>): Promise<string | undefined> {
  try {
    return await decode();
  } catch (err) {
    if (err instanceof TypeError) return undefined;
    throw err;
  }
}

const withBom = (text: string | undefined): string | undefined => (text?.startsWith(BOM) ? text : undefined);

/** The file's text; none when it is neither UTF-8 nor UTF-16 with a byte order mark. */
export async function utfText(path: string): Promise<string | undefined> {
  return (await decoded(async () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path))))
    ?? withBom(await decoded(async () => new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(await readFile(path))))
    ?? withBom(await decoded(async () => new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(await readFile(path))));
}

/** The info file's text, read as Windows-1252 when it is neither UTF-8 nor UTF-16, where the reference installer
 *  falls back to Latin-1. */
export async function infoText(path: string): Promise<string> {
  return (await utfText(path)) ?? new TextDecoder('windows-1252', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
}
