// mods.md, A source mod, story 2: rename and exclude or include write a source mod's build file with its folder, so the
// folder already equals the next build's output.

import { buildFileIn, lineAtFolderPath, writeBuildFileIn, type Manifest } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';

/** The output folder's new name, or the paths in the mod folder to exclude from the build or include again under the mod
 *  manager's exclusion mark. */
export type BuildFileChange =
  | { readonly output: string }
  | { readonly exclude: readonly string[]; readonly include: readonly string[]; readonly exclusionMark: string };

const folded = (path: string): string => path.toLowerCase();

function changed(buildFile: Manifest, change: BuildFileChange): Manifest {
  if ('output' in change) return { ...buildFile, output: change.output };
  const including = new Set(change.include.map(folded));
  const kept = buildFile.exclude.filter((path) => !including.has(folded(path)));
  const exclude = [...kept, ...change.exclude.filter((path, at) =>
    !kept.some((one) => folded(one) === folded(path)) && change.exclude.findIndex((one) => folded(one) === folded(path)) === at)];
  const excluding = { ...buildFile, exclude };
  return { ...excluding, files: buildFile.files.map((line) => lineAtFolderPath(excluding, line, change.exclusionMark)) };
}

/** Writes the change into the build file of the source mod's repository in `sourceFolder`, keeping all else it says; why
 *  it wrote nothing, if so. */
export async function changeBuildFile(sourceFolder: string, change: BuildFileChange): Promise<string | undefined> {
  try {
    const held = await buildFileIn(sourceFolder);
    if (held === undefined) return `"${sourceFolder}" holds no build file.`;
    if ('refused' in held) return `The source mod in "${sourceFolder}" was not changed: ${held.refused}.`;
    await writeBuildFileIn(sourceFolder, changed(held.manifest, change));
    return undefined;
  } catch (err) {
    return `The build file in "${sourceFolder}" could not be written: ${errorMessage(err)}`;
  }
}
