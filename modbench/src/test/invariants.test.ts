import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../ports/present';
import { SRC } from './scanSource';
import { tsFiles } from './tsFiles';
const read = (relativePath: string) => readFileSync(join(SRC, relativePath), 'utf8');

describe('every MO2 text-file write command has a corpus test', () => {
  const WRITERS = [
    'downloadedFileCommands/downloads.ts', 'modCommands/install.ts', 'modCommands/modCommands.ts',
    'pluginCommands/plugins.ts', 'instanceCommands/instanceCommands.ts',
  ];
  const writeVerbs = WRITERS.flatMap((file) => commandVerbs(read(file)));
  const corpus = tsFiles(SRC, { exclude: ['generated'] }).filter((f) => f.endsWith('Corpus.test.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('finds the write verbs', () => {
    expect(writeVerbs).toEqual(expect.arrayContaining([
      'setModsEnabled', 'moveMods', 'moveSeparators', 'markFiles', 'insertSeparator', 'renameSeparator',
      'deleteSeparators', 'uninstallMods', 'createEmptyMod', 'renameMod', 'switchProfile',
      'setPluginsParticipation', 'setPluginsEnabled', 'reorderPlugins',
      'excludeDownloadedFiles', 'includeDownloadedFiles', 'deleteDownloadedFiles', 'installMod', 'modSyncOver', 'pluginSyncOver',
    ]));
    expect(writeVerbs).not.toContain('refresh');
  });

  it.each(writeVerbs)('%s', (verb) => {
    expect(corpus).toMatch(new RegExp(`\\b${verb}\\(`));
  });
});

function commandVerbs(source: string): string[] {
  const bound = new Set([...source.matchAll(/TailOf<typeof (\w+)>/g)].map((m) => m[1]));
  return [...source.matchAll(/^(export )?(?:async )?function (\w+)([\s\S]*?)\{\n/gm)]
    .filter((m) => /InstanceAdapter|SourceModWriters/.test(present(m[3], "the signature")))
    .filter((m) => m[1] !== undefined || bound.has(m[2]))
    .filter((m) => /applied|Result[<>]|SelectionOutcome<|Run\s*$/.test(present(m[3], "the function body between signature and opening brace")))
    .map((m) => present(m[2], "the function's name"));
}
