/** A meta.ini that records the file a mod was installed from, as MO2 writes the path: a QSettings string, its backslashes escaped. */
export const installationFileMeta = (path: string): string => `[General]\r\ninstallationFile=${path.replaceAll('\\', '\\\\')}\r\n`;
