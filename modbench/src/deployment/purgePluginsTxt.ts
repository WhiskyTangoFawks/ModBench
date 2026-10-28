import { readFile } from 'node:fs/promises';
import { fileIdAt, moved, setAside, type Step } from './changes';
import { MARK } from './pluginsTxt';
import type { WrittenPluginsTxt } from './record';

export interface PluginsTxtPurge {
  /** Absent when purge changes nothing there. */
  readonly step: Step | undefined;
  /** The file purge puts back. */
  readonly restored: string | undefined;
  /** Each file deploy renamed that is still there and that purge leaves. */
  readonly left: readonly string[];
  /** The file deploy wrote, once the step has set it aside; the caller removes it when the purge lands. */
  readonly setAside: () => string | undefined;
}

// A plugins.txt that is not deploy's stays, and so does each file deploy renamed (ADR-0003).
export async function purgePluginsTxt({ path, ino, renamed }: WrittenPluginsTxt): Promise<PluginsTxtPurge> {
  const present = await fileIdAt(path);
  const isDeploys = present !== undefined && (present === ino || (await readFile(path, 'utf8')).startsWith(MARK));
  const there: string[] = [];
  for (const name of renamed) if (await fileIdAt(name) !== undefined) there.push(name);
  const back = present === undefined || isDeploys ? there.at(-1) : undefined;
  let aside: string | undefined;
  const step: Step = async () => {
    if (isDeploys) aside = await setAside(path);
    try {
      if (back !== undefined) await moved(back, path);
    } catch (err) {
      if (aside !== undefined) await moved(aside, path);
      throw err;
    }
    return {
      left: `${path}, which purge removed`,
      run: async () => {
        if (back !== undefined) await moved(path, back);
        if (aside !== undefined) await moved(aside, path);
      },
    };
  };
  return {
    step: isDeploys || back !== undefined ? step : undefined,
    restored: back,
    left: there.filter((name) => name !== back),
    setAside: () => aside,
  };
}
