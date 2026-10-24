// A FOMOD's XML files as the reference installer reads them: UTF-8, UTF-16 by its byte order mark, or else
// Windows-1252, where the reference falls back to Latin-1. The text keeps its byte order mark.

import { readFile } from 'node:fs/promises';

const BOM = '﻿';

async function decoded(decode: () => Promise<string>): Promise<string | undefined> {
  try {
    return await decode();
  } catch (err) {
    if (err instanceof TypeError) return undefined;
    throw err;
  }
}

const withBom = (text: string | undefined): string | undefined => (text?.startsWith(BOM) ? text : undefined);

export async function releaseXmlText(path: string): Promise<string> {
  return (await decoded(async () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path))))
    ?? withBom(await decoded(async () => new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(await readFile(path))))
    ?? withBom(await decoded(async () => new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(await readFile(path))))
    ?? new TextDecoder('windows-1252', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
}
