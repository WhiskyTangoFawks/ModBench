import { join } from 'node:path';
import { SCRIPT_EXTENDER_FOLDERS } from '../../tables/gamePaths';
import { present } from '../../ports/present';
import { ignoreSkippedLink, listEntries } from '../files';

const DATA_DIRS = new Set([
  'meshes', 'textures', 'materials', 'sound', 'music', 'scripts', 'source',
  'interface', 'strings', 'mcm', 'seq', 'video', 'vis',
  'lodsettings', 'shadersfx', 'grass', 'terrain', 'planetdata', 'programs',
  'scaleform', 'facegen', 'actors', 'distantlod',
  ...SCRIPT_EXTENDER_FOLDERS,
]);

const MAX_WRAPPERS = 32;

const named = (name: string) => (entry: { name: string }): boolean => entry.name.toLowerCase() === name;

/** A FOMOD's installer: a module config, or a script. */
export type FomodKind = 'xml' | 'script';

const INSTALLER_FILES: readonly [string, FomodKind][] = [['moduleconfig.xml', 'xml'], ['script.cs', 'script']];

async function installerIn(fomodDir: string): Promise<FomodKind | undefined> {
  const files = (await listEntries(fomodDir, ignoreSkippedLink)).filter((entry) => entry.isFile);
  return INSTALLER_FILES.find(([name]) => files.some(named(name)))?.[1];
}

/** Where a release's files start: its Data folder, below each lone wrapper folder, or beside its FOMOD's installer. */
export async function releaseRoot(extracted: string): Promise<{ root: string; fomod?: FomodKind }> {
  let level = extracted;
  for (let depth = 0; depth < MAX_WRAPPERS; depth++) {
    const entries = await listEntries(level, ignoreSkippedLink);
    const folders = entries.filter((entry) => entry.isDirectory);

    const fomodDir = folders.find(named('fomod'));
    const fomod = fomodDir && (await installerIn(join(level, fomodDir.name)));
    if (fomod) return { root: level, fomod };

    const dataDir = folders.find(named('data'));
    if (dataDir) return { root: join(level, dataDir.name) };

    const onlyFolder = folders.length === 1 && entries.every((entry) => !entry.isFile) ? present(folders[0], 'the lone folder') : undefined;
    if (onlyFolder === undefined || DATA_DIRS.has(onlyFolder.name.toLowerCase())) return { root: level };
    level = join(level, onlyFolder.name);
  }
  return { root: level };
}
