import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, sep } from 'node:path';
import ts from 'typescript';
import { pathSegments, productionFiles, SOURCE_ROOTS, SRC, WEBVIEW_SRC } from './scanSource';
import { tsFiles } from './tsFiles';

interface Codec {
  file: string;
  test: string;
}

const codecsIn = (dir: string, testDir: string, names: readonly string[]): Codec[] =>
  names.map((name) => ({ file: join(dir, `${name}.ts`), test: join(testDir, `${name}.test.ts`) }));

const ADAPTER_CODECS = join('instanceAdapter', 'codecs');
const LOAD_ORDER_FILE_CODEC = join('loadOrderFileCodec', 'pluginsText.ts');

interface Format {
  readonly codecs: readonly Codec[];
  readonly tokens: readonly string[];
}

const MANAGER_FORMATS: Format = {
  codecs: codecsIn(ADAPTER_CODECS, join('instanceAdapter', 'test', 'codecs'), ['modlistText', 'metaIni', 'modOrganizerIni', 'downloads']),
  tokens: [
    '+', '-', '_separator', '[General]', 'selected_profile', 'gameName', 'gamePath',
    'download_directory', 'installed', 'uninstalled', 'removed',
  ],
};
const GAME_FORMAT: Format = {
  codecs: codecsIn('loadOrderFileCodec', join('loadOrderFileCodec', 'test'), ['pluginsText']),
  tokens: ['*'],
};
const FORMATS = [MANAGER_FORMATS, GAME_FORMAT];
const TOKENS = FORMATS.flatMap((format) => format.tokens);

const THIS_FILE_HOLDING_EVERY_TOKEN_AS_DATA_NOT_READING_ANY_INSTANCE_FILE = 'formatLiteralScan.test.ts';

interface LayoutName {
  readonly owners: readonly string[];
  readonly inMessages?: true;
}

const LAYOUT: Record<string, LayoutName> = {
  profiles: { owners: [join('instanceAdapter', 'layout.ts')] },
  mods: { owners: [join('instanceAdapter', 'layout.ts')] },
  downloads: { owners: [join('instanceAdapter', 'layout.ts')] },
  overwrite: { owners: [join(ADAPTER_CODECS, 'modlistText.ts')] },
  'modlist.txt': { owners: [join(ADAPTER_CODECS, 'modlistText.ts')], inMessages: true },
  'ModOrganizer.ini': { owners: [join(ADAPTER_CODECS, 'modOrganizerIni.ts')], inMessages: true },
  'meta.ini': { owners: [join(ADAPTER_CODECS, 'metaIni.ts')], inMessages: true },
  '.meta': { owners: [join(ADAPTER_CODECS, 'downloads.ts')], inMessages: true },
  '.mohidden': { owners: [join('instanceAdapter', 'layout.ts')], inMessages: true },
  'plugins.txt': { owners: [LOAD_ORDER_FILE_CODEC] },
};
const LAYOUT_NAMES = Object.keys(LAYOUT);

function stringLiterals(sourceText: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tokenLeaks(sourceText: string, fileName: string): string[] {
  const literals = new Set(stringLiterals(sourceText, fileName));
  return TOKENS.filter((tok) => literals.has(tok));
}

const isCodecOrItsTest = (path: string, { file, test }: Codec): boolean => path.endsWith(sep + file) || path.endsWith(sep + test);

function allowedTokens(path: string): ReadonlySet<string> {
  if (basename(path) === THIS_FILE_HOLDING_EVERY_TOKEN_AS_DATA_NOT_READING_ANY_INSTANCE_FILE) return new Set(TOKENS);
  return new Set(FORMATS.filter((format) => format.codecs.some((codec) => isCodecOrItsTest(path, codec))).flatMap((f) => f.tokens));
}

const allFiles = (roots: readonly string[]): string[] =>
  roots.flatMap((root) => tsFiles(root, { exclude: ['generated'] }));

function findLeaks(roots: readonly string[]): Record<string, string[]> {
  const leaks: Record<string, string[]> = {};
  for (const path of allFiles(roots)) {
    const allowed = allowedTokens(path);
    const found = tokenLeaks(readFileSync(path, 'utf8'), path).filter((token) => !allowed.has(token));
    if (found.length > 0) leaks[path] = found;
  }
  return leaks;
}

describe('format literals, scanned over the extension and webview trees against each format\'s codec allowlist', () => {
  it('covers the whole extension source tree', () => {
    expect(allFiles(SOURCE_ROOTS).length).toBeGreaterThan(100);
  });

  it('reaches the webview tree too, not only the extension host’s, as it is built and shipped from its own tsconfig and a walk stopping at src/ would let it spell anything', () => {
    expect(allFiles(SOURCE_ROOTS)).toContain(join(WEBVIEW_SRC, 'RecordPanel.tsx'));
  });

  it('every codec file exists and names at least one token of its own format, so the list is load-bearing rather than decorative', () => {
    const codecsNamingNoTokenOfTheirFormat = FORMATS.flatMap(({ codecs, tokens }) => codecs
      .map(({ file }) => file)
      .filter((file) => {
        const path = join(SRC, file);
        return tokenLeaks(readFileSync(path, 'utf8'), path).filter((token) => tokens.includes(token)).length === 0;
      }));

    expect(codecsNamingNoTokenOfTheirFormat).toEqual([]);
  });

  it('appear only in their own format\'s codec or its own test, nowhere else in either tree', () => {
    expect(findLeaks(SOURCE_ROOTS)).toEqual({});
  });

  it('the tree walk itself catches a literal planted in a nested non-kernel production file, a handler re-deriving a format marker by hand instead of calling the kernel module that owns it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'unrelated';\n");
      const planted = join(dir, 'nested', 'notKernel.ts');
      await writeFile(planted, "export const marker = '_separator';\n");
      expect(findLeaks([dir])).toEqual({ [planted]: ['_separator'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the tree walk itself catches a literal planted in a nested .tsx file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      const planted = join(dir, 'nested', 'notKernel.tsx');
      await writeFile(planted, "export const marker = '_separator';\n");
      expect(findLeaks([dir])).toEqual({ [planted]: ['_separator'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags a literal planted in a non-kernel test file, the codec\'s own test being allowed and not every test in the suite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      const planted = join(dir, 'someOtherComponent.test.ts');
      await writeFile(planted, "const line = (enabled: boolean) => enabled ? '+' : '-';\n");
      expect(tokenLeaks(readFileSync(planted, 'utf8'), planted)).toEqual(expect.arrayContaining(['+', '-']));
      expect(allowedTokens(planted)).toEqual(new Set());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not flag the same token embedded inside a larger fixture string', () => {
    const src = "const ini = '[General]\\nselected_profile=@ByteArray(Default)\\n';\n";
    expect(tokenLeaks(src, 'x.ts')).toEqual([]);
  });

  it('does not flag a token that appears only inside a comment or a prose test title', () => {
    const src = "// MO2's own `gamePath` key, read elsewhere\nit('the `*` prefix means enabled');\n";
    expect(tokenLeaks(src, 'x.test.ts')).toEqual([]);
  });

  it('collects a template head as well as a no-substitution template', () => {
    const src = 'const a = `_separator${suffix}`;\nconst b = `+`;\n';
    expect(tokenLeaks(src, 'x.ts')).toEqual(expect.arrayContaining(['_separator', '+']));
  });

  it('allows a codec module’s own test file its own format\'s tokens', () => {
    expect(allowedTokens(join('src', 'instanceAdapter', 'test', 'codecs', 'modlistText.test.ts'))).toEqual(new Set(MANAGER_FORMATS.tokens));
    expect(allowedTokens(join('src', 'loadOrderFileCodec', 'test', 'pluginsText.test.ts'))).toEqual(new Set(GAME_FORMAT.tokens));
  });

  it('allows no token to a file in a codec box that is not a codec module or its test', () => {
    expect(allowedTokens(join('src', 'instanceAdapter', 'test', 'layout.test.ts'))).toEqual(new Set());
    expect(allowedTokens(join('src', 'instanceAdapter', 'mo2Instance.ts'))).toEqual(new Set());
  });

  it('the Instance adapter holds no plugins.txt codec of its own, which would put the game\'s format inside one mod manager\'s implementation', () => {
    expect(allowedTokens(join('src', 'instanceAdapter', 'codecs', 'pluginsText.ts'))).toEqual(new Set());
  });

  it('catches a format\'s marker planted in the other format\'s codec: an MO2 codec spelling the game\'s enabled marker, or the game\'s codec spelling MO2\'s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-format-literal-scan-'));
    try {
      await mkdir(join(dir, 'instanceAdapter', 'codecs'), { recursive: true });
      await mkdir(join(dir, 'loadOrderFileCodec'));
      const managerCodec = join(dir, 'instanceAdapter', 'codecs', 'modlistText.ts');
      const gameCodec = join(dir, 'loadOrderFileCodec', 'pluginsText.ts');
      await writeFile(managerCodec, "export const marks = ['+', '*'];\n");
      await writeFile(gameCodec, "export const marks = ['*', '_separator'];\n");
      expect(findLeaks([dir])).toEqual({ [managerCodec]: ['*'], [gameCodec]: ['_separator'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function everyLiteralText(sourceText: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const namesFile = (literal: string, name: string): boolean =>
  literal.split(name).slice(1).some((after) => !/^\w/.test(after));

function layoutLeaks(sourceText: string, fileName: string): string[] {
  const segments = pathSegments(sourceText, fileName);
  const literals = everyLiteralText(sourceText, fileName);
  return LAYOUT_NAMES.filter((name) => segments.has(name)
    || (LAYOUT[name]?.inMessages === true && literals.some((literal) => namesFile(literal, name))));
}

function findLayoutLeaks(roots: readonly string[]): Record<string, string[]> {
  const leaks: Record<string, string[]> = {};
  for (const path of roots.flatMap((root) => productionFiles(root))) {
    const leaked = new Set(layoutLeaks(readFileSync(path, 'utf8'), path));
    const found = Object.entries(LAYOUT)
      .filter(([name, { owners }]) => leaked.has(name) && !owners.some((owner) => path.endsWith(sep + owner)))
      .map(([name]) => name);
    if (found.length > 0) leaks[path] = found;
  }
  return leaks;
}

describe('layout names', () => {
  it('every name is spelled by each file that owns it, a name dropped from its owner freeing every other file to spell it again with the production assertion still green', () => {
    const ownersLackingTheirName = Object.entries(LAYOUT).flatMap(([name, { owners }]) => owners
      .filter((owner) => {
        const path = join(SRC, owner);
        return !layoutLeaks(readFileSync(path, 'utf8'), path).includes(name);
      })
      .map((owner) => `${owner} lacks ${name}`));

    expect(ownersLackingTheirName).toEqual([]);
  });

  it('appear in no production file of either tree but their owner', () => {
    expect(findLayoutLeaks(SOURCE_ROOTS)).toEqual({});
  });

  it('the walk catches a name planted in a nested production file that owns none of them, a mod folder guessed as the mods directory joined with an origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-layout-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'unrelated';\n");
      const planted = join(dir, 'nested', 'guess.ts');
      await writeFile(planted, "export const modFolder = (root: string, origin: string) => join(root, 'mods', origin);\n");
      expect(findLayoutLeaks([dir])).toEqual({ [planted]: ['mods'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('catches a name spelled as one segment of a watcher glob', () => {
    expect(layoutLeaks("watch(root, 'profiles/*/plugins.txt');\n", 'x.ts')).toEqual(['profiles', 'plugins.txt']);
  });

  it('catches a file of the manager\'s named in a message, in a template\'s tail too', () => {
    expect(layoutLeaks('export const say = (mod: string) => `"${mod}" was created, but its modlist.txt line could not be written.`;\n', 'x.ts'))
      .toEqual(['modlist.txt']);
    expect(layoutLeaks('export const say = (name: string) => `${name}.meta was left behind.`;\n', 'x.ts')).toEqual(['.meta']);
    expect(layoutLeaks("export const tooltip = 'Mod files tools wrote, in ModOrganizer.ini';\n", 'x.ts')).toEqual(['ModOrganizer.ini']);
  });

  it('catches a directory name only as a path segment, not in prose', () => {
    expect(layoutLeaks("join(base, 'profiles', 'overwrite');\n", 'x.ts')).toEqual(['profiles', 'overwrite']);
    expect(layoutLeaks("export const say = 'the mods and profiles are fine';\n", 'x.ts')).toEqual([]);
  });

  it('does not flag a file of the manager\'s named in a comment, or a longer name one begins', () => {
    expect(layoutLeaks('// reads modlist.txt\n', 'x.ts')).toEqual([]);
    expect(layoutLeaks("export const say = 'its .metadata';\n", 'x.ts')).toEqual([]);
    expect(layoutLeaks('export const say = (file: string) => `its ${file} line could not be written.`;\n', 'x.ts')).toEqual([]);
  });

  it('does not flag a name inside a longer path segment, or one only in prose', () => {
    expect(layoutLeaks("const msg = 'Cannot deploy: mods/ and the game directory differ';\n", 'x.ts')).toEqual([]);
    expect(layoutLeaks("const key = 'modbench.mods.gameDirectory';\n", 'x.ts')).toEqual([]);
  });

  it('does not flag a module specifier', () => {
    expect(layoutLeaks("import { parseDownloadMeta } from './codecs/downloads';\n", 'x.ts')).toEqual([]);
  });

  it('does not flag a literal type, which can never be a path', () => {
    expect(layoutLeaks("type V = Pick<InstanceValue, 'mods' | 'downloads'>;\n", 'x.ts')).toEqual([]);
  });

  it('does not flag a Nexus URL’s own path segments, a template\'s middle and tail not being visited so a name spliced after a substitution escapes the scan', () => {
    expect(layoutLeaks('const url = `https://www.nexusmods.com/${slug}/mods/${id}`;\n', 'x.ts')).toEqual([]);
  });

  it('leaves test files to spell their own fixtures, their literal paths keeping them independent of the layout module under test', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-layout-scan-'));
    try {
      await mkdir(join(dir, 'box', 'test'), { recursive: true });
      await writeFile(join(dir, 'box', 'test', 'fixture.ts'), "export const root = join(base, 'mods');\n");
      await writeFile(join(dir, 'box', 'guess.test.ts'), "export const root = join(base, 'mods');\n");
      expect(findLayoutLeaks([dir])).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the Instance adapter spells the directory names and no file name of a codec’s, a codec\'s file name spelled in the layout too being how one name gets two spellers without either scan noticing', () => {
    const path = join(SRC, 'instanceAdapter', 'layout.ts');
    expect(layoutLeaks(readFileSync(path, 'utf8'), path)).toEqual(['profiles', 'mods', 'downloads', '.mohidden']);
  });
});
