import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Top-level folder names that mean "this level is already the mod's data root"
 *  (a game data subfolder), so a lone one of them must NOT be peeled as a wrapper. */
const DATA_DIRS = new Set([
  'meshes', 'textures', 'materials', 'sound', 'music', 'scripts', 'source',
  'interface', 'strings', 'f4se', 'skse', 'mcm', 'seq', 'video', 'vis',
  'lodsettings', 'shadersfx', 'grass', 'terrain', 'planetdata', 'programs',
  'scaleform', 'facegen', 'actors', 'distantlod',
]);

/** Resolve which directory's contents become `mods/<name>/`.
 *
 *  - A `fomod/ModuleConfig.xml` marks a scripted installer: `isFomod` is set but
 *    the tree is left as-is (the wizard is a separate sub-project).
 *  - A `Data/` subfolder is the mod's data root.
 *  - A single wrapper folder (`archive/ModName/…`) is peeled and re-evaluated.
 *  - Otherwise the level itself is the root (loose plugins/meshes). */
export async function detectRoot(
  stagingDir: string,
): Promise<{ sourceDir: string; isFomod: boolean }> {
  let level = stagingDir;
  for (let depth = 0; depth < 32; depth++) {
    const entries = await readdir(level, { withFileTypes: true });

    const fomodDir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'fomod');
    if (fomodDir && (await hasModuleConfig(join(level, fomodDir.name)))) {
      return { sourceDir: level, isFomod: true };
    }

    const dataDir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'data');
    if (dataDir) return { sourceDir: join(level, dataDir.name), isFomod: false };

    const dirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile());
    if (dirs.length === 1 && files.length === 0 && !DATA_DIRS.has(dirs[0].name.toLowerCase())) {
      level = join(level, dirs[0].name);
      continue;
    }

    return { sourceDir: level, isFomod: false };
  }
  return { sourceDir: level, isFomod: false };
}

async function hasModuleConfig(fomodDir: string): Promise<boolean> {
  const entries = await readdir(fomodDir, { withFileTypes: true });
  return entries.some((e) => e.isFile() && e.name.toLowerCase() === 'moduleconfig.xml');
}
