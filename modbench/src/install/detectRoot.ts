import { join } from 'node:path';
import { SCRIPT_EXTENDER_FOLDERS } from '../tables/gamePaths';
import { present } from '../ports/present';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

const DATA_DIRS = new Set([
  'meshes', 'textures', 'materials', 'sound', 'music', 'scripts', 'source',
  'interface', 'strings', 'mcm', 'seq', 'video', 'vis',
  'lodsettings', 'shadersfx', 'grass', 'terrain', 'planetdata', 'programs',
  'scaleform', 'facegen', 'actors', 'distantlod',
  ...SCRIPT_EXTENDER_FOLDERS,
]);

/** A `fomod/ModuleConfig.xml` marks a scripted installer: `isFomod` is set but the
 *  tree is left as-is, because the wizard is a separate sub-project. */
export async function detectRoot(
  adapter: Pick<InstanceAdapter, 'extractedEntries'>, extractionDir: string,
): Promise<{ sourceDir: string; isFomod: boolean }> {
  let level = extractionDir;
  for (let depth = 0; depth < 32; depth++) {
    const entries = await adapter.extractedEntries(level);

    const fomodDir = entries.find((e) => e.kind === 'folder' && e.name.toLowerCase() === 'fomod');
    if (fomodDir && (await hasModuleConfig(adapter, join(level, fomodDir.name)))) {
      return { sourceDir: level, isFomod: true };
    }

    const dataDir = entries.find((e) => e.kind === 'folder' && e.name.toLowerCase() === 'data');
    if (dataDir) return { sourceDir: join(level, dataDir.name), isFomod: false };

    const dirs = entries.filter((e) => e.kind === 'folder');
    const files = entries.filter((e) => e.kind === 'file');
    if (dirs.length === 1 && files.length === 0) {
      const onlyDir = present(dirs[0], 'the sole entry of a single-directory level');
      if (!DATA_DIRS.has(onlyDir.name.toLowerCase())) {
        level = join(level, onlyDir.name);
        continue;
      }
    }

    return { sourceDir: level, isFomod: false };
  }
  return { sourceDir: level, isFomod: false };
}

async function hasModuleConfig(adapter: Pick<InstanceAdapter, 'extractedEntries'>, fomodDir: string): Promise<boolean> {
  const entries = await adapter.extractedEntries(fomodDir);
  return entries.some((e) => e.kind === 'file' && e.name.toLowerCase() === 'moduleconfig.xml');
}
