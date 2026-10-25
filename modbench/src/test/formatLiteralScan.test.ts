import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import ts from 'typescript';
import { pathSegments, plantedTree, productionFiles, sourceFiles, SOURCE_ROOTS, SRC, WEBVIEW_SRC } from './scanSource';

interface Codec {
  file: string;
  test: string;
}

const codecsIn = (dir: string, testDir: string, names: readonly string[]): Codec[] =>
  names.map((name) => ({ file: join(dir, `${name}.ts`), test: join(testDir, `${name}.test.ts`) }));

const ADAPTER_CODECS = join('instanceAdapter', 'mo2', 'codecs');
const LOAD_ORDER_FILE_CODEC = join('loadOrderFileCodec', 'pluginsText.ts');

interface Format {
  readonly codecs: readonly Codec[];
  readonly tokens: readonly string[];
}

const MANAGER_FORMATS: Format = {
  codecs: codecsIn(ADAPTER_CODECS, join('instanceAdapter', 'mo2', 'test', 'codecs'), ['modlistText', 'metaIni', 'modOrganizerIni', 'downloads', 'bbcode']),
  tokens: [
    '+', '-', '*', '_separator', '[General]', 'selected_profile', 'gameName', 'gamePath',
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
  readonly matchedWithinLiterals?: true;
}

const LAYOUT: Record<string, LayoutName> = {
  profiles: { owners: [join('instanceAdapter', 'mo2', 'layout.ts')] },
  mods: { owners: [join('instanceAdapter', 'mo2', 'layout.ts')] },
  downloads: { owners: [join('instanceAdapter', 'mo2', 'layout.ts')] },
  overwrite: { owners: [join(ADAPTER_CODECS, 'modlistText.ts'), join('wire', 'pluginAddress.ts')] },
  'modlist.txt': { owners: [join(ADAPTER_CODECS, 'modlistText.ts')], matchedWithinLiterals: true },
  'ModOrganizer.ini': { owners: [join(ADAPTER_CODECS, 'modOrganizerIni.ts')], matchedWithinLiterals: true },
  'meta.ini': { owners: [join(ADAPTER_CODECS, 'metaIni.ts')], matchedWithinLiterals: true },
  '.meta': { owners: [join(ADAPTER_CODECS, 'downloads.ts')], matchedWithinLiterals: true },
  '.mohidden': { owners: [join('instanceAdapter', 'mo2', 'layout.ts')], matchedWithinLiterals: true },
  'plugins.txt': { owners: [LOAD_ORDER_FILE_CODEC] },
};
const LAYOUT_NAMES = Object.keys(LAYOUT);

function stringLiterals(
  sourceText: string,
  fileName: string,
  isTemplatePart: (node: ts.Node) => node is ts.TemplateLiteralToken = ts.isTemplateHead,
): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || isTemplatePart(node)) found.push(node.text);
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

function findLeaks(roots: readonly string[]): Record<string, string[]> {
  const leaks: Record<string, string[]> = {};
  for (const path of sourceFiles(roots)) {
    const allowed = allowedTokens(path);
    const found = tokenLeaks(readFileSync(path, 'utf8'), path).filter((token) => !allowed.has(token));
    if (found.length > 0) leaks[path] = found;
  }
  return leaks;
}

describe('format literals, scanned over the extension and webview trees against each format\'s codec allowlist', () => {
  it('covers the whole extension source tree', () => {
    expect(sourceFiles(SOURCE_ROOTS).length).toBeGreaterThan(100);
  });

  it('reaches the webview tree too, not only the extension host’s, as it is built and shipped from its own tsconfig and a walk stopping at src/ would let it spell anything', () => {
    expect(sourceFiles(SOURCE_ROOTS)).toContain(join(WEBVIEW_SRC, 'RecordPanel.tsx'));
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

  it.each(['ts', 'tsx'])('the tree walk itself catches a literal planted in a nested .%s production file, a handler re-deriving a format marker by hand instead of calling the kernel module that owns it', (extension) => {
    const dir = plantedTree({ 'topLevel.ts': "export const label = 'unrelated';\n", [`nested/notKernel.${extension}`]: "export const marker = '_separator';\n" });
    expect(findLeaks([dir])).toEqual({ [join(dir, 'nested', `notKernel.${extension}`)]: ['_separator'] });
  });

  it.each([
    ['catches a token a test file other than the codec\'s own spells', "const line = (enabled: boolean) => enabled ? '+' : '-';\n", 'someOtherComponent.test.ts', ['+', '-']],
    ['collects a template head as well as a no-substitution template', 'const a = `_separator${suffix}`;\nconst b = `+`;\n', 'x.ts', ['+', '_separator']],
    ['does not flag the same token embedded inside a larger fixture string', "const ini = '[General]\\nselected_profile=@ByteArray(Default)\\n';\n", 'x.ts', []],
    ['does not flag a token that appears only inside a comment or a prose test title',
      "// MO2's own `gamePath` key, read elsewhere\nit('the `*` prefix means enabled');\n", 'x.test.ts', []],
  ])('%s', (_, text, fileName, leaked) => {
    expect(tokenLeaks(text, fileName)).toEqual(leaked);
  });

  it.each([
    ['a manager codec\'s own test its format\'s tokens', join('src', 'instanceAdapter', 'mo2', 'test', 'codecs', 'modlistText.test.ts'), MANAGER_FORMATS.tokens],
    ['the game codec\'s own test its format\'s tokens', join('src', 'loadOrderFileCodec', 'test', 'pluginsText.test.ts'), GAME_FORMAT.tokens],
    ['no token to a test in a codec box that is not a codec\'s', join('src', 'instanceAdapter', 'mo2', 'test', 'layout.test.ts'), []],
    ['no token to a module in a codec box that is not a codec', join('src', 'instanceAdapter', 'mo2', 'mo2Instance.ts'), []],
    ['no token to a test of no codec', 'someOtherComponent.test.ts', []],
    ['no token to a plugins.txt codec inside the Instance adapter, which would put the game\'s format inside one mod manager\'s implementation',
      join('src', 'instanceAdapter', 'mo2', 'codecs', 'pluginsText.ts'), []],
  ])('allows %s', (_, path, tokens) => {
    expect(allowedTokens(path)).toEqual(new Set(tokens));
  });

  it('catches MO2\'s markers planted in the game\'s codec', () => {
    const dir = plantedTree({
      'instanceAdapter/mo2/codecs/modlistText.ts': "export const marks = ['+'];\n",
      'loadOrderFileCodec/pluginsText.ts': "export const marks = ['*', '+', '_separator'];\n",
    });
    expect(findLeaks([dir])).toEqual({ [join(dir, 'loadOrderFileCodec', 'pluginsText.ts')]: ['+', '_separator'] });
  });
});

const namesFile = (literal: string, name: string): boolean =>
  literal.split(name).slice(1).some((after) => !/^\w/.test(after));

function layoutLeaks(sourceText: string, fileName: string): string[] {
  const segments = pathSegments(sourceText, fileName);
  const literals = stringLiterals(sourceText, fileName, ts.isTemplateLiteralToken);
  return LAYOUT_NAMES.filter((name) => segments.has(name)
    || (LAYOUT[name]?.matchedWithinLiterals === true && literals.some((literal) => namesFile(literal, name))));
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

  it('the walk catches a name planted in a nested production file that owns none of them, a mod folder guessed as the mods directory joined with an origin', () => {
    const dir = plantedTree({
      'topLevel.ts': "export const label = 'unrelated';\n",
      'nested/guess.ts': "export const modFolder = (root: string, origin: string) => join(root, 'mods', origin);\n",
    });
    expect(findLayoutLeaks([dir])).toEqual({ [join(dir, 'nested', 'guess.ts')]: ['mods'] });
  });

  it.each([
    ['catches a name spelled as one segment of a watcher glob', "watch(root, 'profiles/*/plugins.txt');\n", ['profiles', 'plugins.txt']],
    ['catches a file of the manager\'s named in a message', "export const tooltip = 'Mod files tools wrote, in ModOrganizer.ini';\n", ['ModOrganizer.ini']],
    ['catches a file of the manager\'s named in a template\'s tail',
      'export const say = (mod: string) => `"${mod}" was created, but its modlist.txt line could not be written.`;\n', ['modlist.txt']],
    ['catches a file extension of the manager\'s named in a template\'s tail', 'export const say = (name: string) => `${name}.meta was left behind.`;\n', ['.meta']],
    ['catches a directory name as a path segment', "join(base, 'profiles', 'overwrite');\n", ['profiles', 'overwrite']],
    ['does not flag a directory name in prose', "export const say = 'the mods and profiles are fine';\n", []],
    ['does not flag a file of the manager\'s named in a comment', '// reads modlist.txt\n', []],
    ['does not flag a longer name one begins', "export const say = 'its .metadata';\n", []],
    ['does not flag a substitution beside the words of a file\'s line', 'export const say = (file: string) => `its ${file} line could not be written.`;\n', []],
    ['does not flag a name inside a longer path segment', "const msg = 'Cannot deploy: mods/ and the game folder differ';\n", []],
    ['does not flag a name inside a setting key', "const key = 'modbench.mods.gameFolder';\n", []],
    ['does not flag a module specifier', "import { parseDownloadedFileMeta } from './codecs/downloads';\n", []],
    ['does not flag a literal type, which can never be a path', "type V = Pick<InstanceValue, 'mods' | 'downloads'>;\n", []],
    ['does not flag a Nexus URL’s own path segments, a template\'s middle and tail not being visited so a name spliced after a substitution escapes the scan',
      'const url = `https://www.nexusmods.com/${slug}/mods/${id}`;\n', []],
  ])('%s', (_, text, leaked) => {
    expect(layoutLeaks(text, 'x.ts')).toEqual(leaked);
  });

  it('leaves test files to spell their own fixtures, their literal paths keeping them independent of the layout module under test', () => {
    const dir = plantedTree({
      'box/test/fixture.ts': "export const root = join(base, 'mods');\n",
      'box/guess.test.ts': "export const root = join(base, 'mods');\n",
    });
    expect(findLayoutLeaks([dir])).toEqual({});
  });
});
