// A file the Downloads view read of its own is a second generation of a row the Instance's value
// already holds (ADR-0015 invariant 6); a file it wrote skipped the commands box.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../../ports/present';

const VIEW_DIR = join(__dirname, '..');

// Walked, never listed: a file added to the box is bound by the rule the day it lands.
const VIEW_FILES = readdirSync(VIEW_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

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

// The host's own file system, which is how VS Code trashes: the view is handed the trash instead.
const HOST_FS = 'workspace.fs';

function fileAccessIn(source: string): string[] {
  const imported = importsOf(source).filter((spec) => FS_MODULES.includes(spec));
  const host = code(source).includes(HOST_FS) ? [HOST_FS] : [];
  return [...imported, ...FS_CALLS.filter((call) => new RegExp(`\\b${call}\\(`).test(code(source))), ...host];
}

const read = (file: string): string => readFileSync(join(VIEW_DIR, file), 'utf8');

describe('the Downloads view imports no filesystem module and names no filesystem call', () => {
  it('walks every file the view is made of', () => {
    expect(VIEW_FILES).toEqual(expect.arrayContaining([
      'DownloadsPanel.ts', 'DownloadsProvider.ts', 'ExcludedDownloadDecorationProvider.ts',
      'downloadRows.ts', 'errorNode.ts', 'instanceFirstRead.ts', 'upgradeCandidates.ts',
    ]));
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

  // Rival this catches: the view trashing a download through the host itself.
  it('flags a write through the host file system', () => {
    const planted = "await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });\n";
    expect(fileAccessIn(planted)).toEqual(['workspace.fs']);
  });

  it('does not flag the word in a comment or a command id', () => {
    expect(fileAccessIn("// re-reads nothing: no readFile( here\nvoid run('modbench.downloadedFile.open');\n")).toEqual([]);
  });
});
