import { manifestIn, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';

/** The manifest a folder holds; none when it holds none or one of the format before version 1, which pre-alpha Modbench
 *  writes over; or why it cannot be read. */
export async function heldManifestIn(folder: string): Promise<Manifest | undefined | { readonly why: string }> {
  try {
    const held = await manifestIn(folder);
    if (held === undefined || 'olderFormat' in held) return undefined;
    return 'refused' in held ? { why: `${held.refused}.` } : held.manifest;
  } catch (err) {
    return { why: `its manifest could not be read: ${errorMessage(err)}` };
  }
}
