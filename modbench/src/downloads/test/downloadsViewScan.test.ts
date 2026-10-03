import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../../ports/present';

const SRC = join(__dirname, '..', '..');

const VIEW_DIRS = ['downloads', 'drivingLib'];

const VIEW_FILES_WALKED_NOT_LISTED = VIEW_DIRS
  .flatMap((dir) => readdirSync(join(SRC, dir)).map((name) => join(dir, name)))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

const FS_MODULES = ['fs', 'fs/promises', 'node:fs', 'node:fs/promises'];

const FS_CALLS_NAMED_BECAUSE_AN_ALIAS_EVADES_THE_IMPORT_CHECK = ['readFile', 'writeFile', 'readdir', 'mkdir', 'rm', 'access', 'stat', 'cp', 'rename'];

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[\s\S]*?from\s+'([^']+)'/g)]
    .map((m) => present(m[1], 'the module-path capture group the pattern always matches'));
}

function codeWithoutCommentLines(source: string): string {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

const HOST_FS_WHICH_IS_HOW_VS_CODE_TRASHES = 'workspace.fs';

function fileAccessIn(source: string): string[] {
  const imported = importsOf(source).filter((spec) => FS_MODULES.includes(spec));
  const host = codeWithoutCommentLines(source).includes(HOST_FS_WHICH_IS_HOW_VS_CODE_TRASHES) ? [HOST_FS_WHICH_IS_HOW_VS_CODE_TRASHES] : [];
  return [...imported, ...FS_CALLS_NAMED_BECAUSE_AN_ALIAS_EVADES_THE_IMPORT_CHECK.filter((call) => new RegExp(`\\b${call}\\(`).test(codeWithoutCommentLines(source))), ...host];
}

const read = (file: string): string => readFileSync(join(SRC, file), 'utf8');

describe('the Downloads view reads no file of its own: it imports no filesystem module and names no filesystem call', () => {
  it('walks every file the view is made of', () => {
    expect(VIEW_FILES_WALKED_NOT_LISTED).toEqual(expect.arrayContaining([
      join('downloads', 'DownloadsPanel.ts'), join('downloads', 'DownloadsProvider.ts'),
      join('downloads', 'ExcludedDownloadDecorationProvider.ts'), join('downloads', 'downloadRows.ts'),
      join('downloads', 'upgradeCandidates.ts'), join('drivingLib', 'errorNode.ts'),
      join('drivingLib', 'instanceFirstRead.ts'),
    ]));
    expect(VIEW_FILES_WALKED_NOT_LISTED.filter((file) => read(file).length === 0)).toEqual([]);
  });

  it.each(VIEW_FILES_WALKED_NOT_LISTED)('%s touches no filesystem module', (file) => {
    expect(fileAccessIn(read(file))).toEqual([]);
  });

  it('flags a gesture re-reading the sidecar: an import of the filesystem and a call made through one', () => {
    const planted = "import { readFile } from 'node:fs/promises';\nconst text = await readFile(metaPath, 'utf8');\n";
    expect(fileAccessIn(planted)).toEqual(['node:fs/promises', 'readFile']);
  });

  it('flags the view trashing a download through the host file system', () => {
    const planted = "await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });\n";
    expect(fileAccessIn(planted)).toEqual(['workspace.fs']);
  });

  it('does not flag the word in a comment or a command id', () => {
    expect(fileAccessIn("// re-reads nothing: no readFile( here\nvoid run('modbench.downloadedFile.open');\n")).toEqual([]);
  });
});
