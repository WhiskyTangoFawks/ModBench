// The Downloads view renders the Instance's value and fires commands. A file it read of its own
// is a second generation of a row that value already holds (ADR-0015 invariant 6); a file it
// wrote is a gesture that skipped the commands box.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../ports/present';

const VIEW_FILES = ['DownloadsPanel.ts', 'DownloadsProvider.ts', 'HiddenDownloadDecorationProvider.ts'];

const FS_MODULES = ['fs', 'fs/promises', 'node:fs', 'node:fs/promises'];

// The filesystem calls the MO2 side makes, named rather than imported: an alias would otherwise
// smuggle a read past the import check.
const FS_CALLS = ['readFile', 'writeFile', 'readdir', 'mkdir', 'rm', 'access', 'stat', 'cp', 'rename'];

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)]
    .map((m) => present(m[1], 'the module-path capture group the pattern always matches'));
}

// Comments are prose: a rule's own statement names the calls it forbids.
function code(source: string): string {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

function fileAccessIn(source: string): string[] {
  const imported = importsOf(source).filter((spec) => FS_MODULES.includes(spec));
  return [...imported, ...FS_CALLS.filter((call) => new RegExp(`\\b${call}\\(`).test(code(source)))];
}

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

describe('the Downloads view imports no filesystem module and names no filesystem call', () => {
  it('names every file the view is made of', () => {
    for (const file of VIEW_FILES) expect(read(file).length).toBeGreaterThan(0);
  });

  it.each(VIEW_FILES)('%s touches no filesystem module', (file) => {
    expect(fileAccessIn(read(file))).toEqual([]);
  });

  // Rival this catches: a gesture re-reading the sidecar for a field the row already carries.
  it('flags an import of the filesystem and a call made through one', () => {
    const planted = "import { readFile } from 'node:fs/promises';\nconst text = await readFile(metaPath, 'utf8');\n";
    expect(fileAccessIn(planted)).toEqual(['node:fs/promises', 'readFile']);
  });

  it('does not flag the word in a comment or a command id', () => {
    expect(fileAccessIn("// re-reads nothing: no readFile( here\nvoid run('modbench.downloads.openFile');\n")).toEqual([]);
  });
});
