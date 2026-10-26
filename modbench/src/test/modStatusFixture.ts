import type { ModStatus } from '../client';

/** A mod whose folder matches its manifest, but for what `over` says. */
export const status = (mod: string, over: Partial<ModStatus> = {}): ModStatus =>
  ({ mod, noManifest: false, differing: [], namedByNoLine: [], gone: [], notInPackage: [], otherBytes: [], metadataDiffers: false, noHost: false, ...over });
