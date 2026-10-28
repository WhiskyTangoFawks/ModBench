// A FOMOD's XML files as the reference installer reads them: in the encoding the first bytes give, else the one the
// declaration names, else UTF-8, else Windows-1252 for the reference's Latin-1.

import { readFile } from 'node:fs/promises';
import { errnoCode } from '../../ports/errno';

const DECLARED = /^<\?xml[^>]*?\bencoding\s*=\s*["']([\w.:-]+)["']/;

// A declaration that names UTF-16 in a document whose first bytes are not UTF-16 names it wrongly.
const SIXTEEN_BIT = /^(utf-?16|ucs-?2|unicode)/i;

const leads = (bytes: Buffer, lead: readonly number[]): boolean => lead.every((byte, i) => bytes[i] === byte);

// XML 1.0, Appendix F.
function sniffed(bytes: Buffer): string | undefined {
  if (leads(bytes, [0xef, 0xbb, 0xbf])) return 'utf-8';
  if (leads(bytes, [0xff, 0xfe]) || leads(bytes, [0x3c, 0x00, 0x3f, 0x00])) return 'utf-16le';
  if (leads(bytes, [0xfe, 0xff]) || leads(bytes, [0x00, 0x3c, 0x00, 0x3f])) return 'utf-16be';
  return undefined;
}

function declared(bytes: Buffer): string | undefined {
  const label = DECLARED.exec(bytes.toString('latin1', 0, 256))?.[1];
  return label === undefined || SIXTEEN_BIT.test(label) ? undefined : label;
}

const UNDECODABLE: ReadonlySet<string | undefined> = new Set(['ERR_ENCODING_INVALID_ENCODED_DATA', 'ERR_ENCODING_NOT_SUPPORTED']);

function decoded(bytes: Buffer, label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (err) {
    if (!UNDECODABLE.has(errnoCode(err))) throw err;
    return undefined;
  }
}

/** The file's text, its byte order mark kept. */
export async function releaseXmlText(path: string): Promise<string> {
  const bytes = await readFile(path);
  return decoded(bytes, sniffed(bytes)) ?? decoded(bytes, declared(bytes)) ?? decoded(bytes, 'utf-8')
    ?? new TextDecoder('windows-1252', { fatal: true, ignoreBOM: true }).decode(bytes);
}
