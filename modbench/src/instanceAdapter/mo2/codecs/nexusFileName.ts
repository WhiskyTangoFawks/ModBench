// The Nexus mod ID MO2 takes from a download's file name (NexusInterface::interpretNexusFileName, query off).

const NEXUS_FILE_NAME =
  /^([a-zA-Z0-9_'"\-.() ]*?)([-_ ][VvRr]+[0-9]+(?:(?:[.][0-9]+){0,2}|(?:[_][0-9]+){0,2}|(?:[-.][0-9]+){0,2})?[ab]?)??-([1-9][0-9]+)?-.*?\.(zip|rar|7z)/;

const INT_MAX = 2 ** 31 - 1;

export function nexusModIdOfFileName(fileName: string): string | undefined {
  const captured = NEXUS_FILE_NAME.exec(fileName)?.[3];
  return captured !== undefined && Number(captured) <= INT_MAX ? captured : undefined;
}
