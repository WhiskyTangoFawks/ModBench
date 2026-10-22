// The Nexus mod ID MO2 takes from an installation file's name (NexusInterface::interpretNexusFileName).

import { qtToInt } from './qtInt';

const NEXUS_FILE_NAME =
  /^([a-zA-Z0-9_'"\-.() ]*?)([-_ ][VvRr]+[0-9]+(?:(?:[.][0-9]+){0,2}|(?:[_][0-9]+){0,2}|(?:[-.][0-9]+){0,2})?[ab]?)??-([1-9][0-9]+)?-.*?\.(zip|rar|7z)/;

const idInFileName = (fileName: string): string | undefined => {
  const captured = NEXUS_FILE_NAME.exec(fileName)?.[3];
  return captured !== undefined && qtToInt(captured) !== 0 ? captured : undefined;
};

/** The metadata's mod ID, else the file name's: MO2's install takes the name's only where the metadata has none. */
export const effectiveModId = (metaModId: string | undefined, fileName: string | undefined): string | undefined =>
  metaModId ?? (fileName === undefined ? undefined : idInFileName(fileName));
