import { join } from 'node:path';
import { SCRIPT_EXTENDER_FOLDERS } from '../tables/gamePaths';
import { present } from '../ports/present';
import { listDir } from './files';

const DATA_DIRS = new Set([
  'meshes', 'textures', 'materials', 'sound', 'music', 'scripts', 'source',
  'interface', 'strings', 'mcm', 'seq', 'video', 'vis',
  'lodsettings', 'shadersfx', 'grass', 'terrain', 'planetdata', 'programs',
  'scaleform', 'facegen', 'actors', 'distantlod',
  ...SCRIPT_EXTENDER_FOLDERS,
]);

const MAX_WRAPPERS = 32;

const named = (name: string) => (entry: { name: string }): boolean => entry.name.toLowerCase() === name;

async function hasModuleConfig(fomodDir: string): Promise<boolean> {
  return (await listDir(fomodDir)).some((entry) => entry.isFile() && named('moduleconfig.xml')(entry));
}

/** Where a release's files start: its Data folder, or below each lone wrapper folder. A
 *  scripted installer keeps its tree as it is, because Modbench does not run its steps. */
export async function releaseRoot(extracted: string): Promise<{ root: string; isFomod: boolean }> {
  let level = extracted;
  for (let depth = 0; depth < MAX_WRAPPERS; depth++) {
    const entries = await listDir(level);
    const folders = entries.filter((entry) => entry.isDirectory());

    const fomodDir = folders.find(named('fomod'));
    if (fomodDir && (await hasModuleConfig(join(level, fomodDir.name)))) return { root: level, isFomod: true };

    const dataDir = folders.find(named('data'));
    if (dataDir) return { root: join(level, dataDir.name), isFomod: false };

    const onlyFolder = folders.length === 1 && entries.every((entry) => !entry.isFile()) ? present(folders[0], 'the lone folder') : undefined;
    if (onlyFolder === undefined || DATA_DIRS.has(onlyFolder.name.toLowerCase())) return { root: level, isFomod: false };
    level = join(level, onlyFolder.name);
  }
  return { root: level, isFomod: false };
}
