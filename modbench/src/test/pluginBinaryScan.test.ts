import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, basename, dirname, relative, sep } from 'node:path';
import ts from 'typescript';
import { present } from '../ports/present';
import { isTestSupport, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const DECODING_READS = new Set(['readFile', 'readFileSync']);

const TEXT_ENCODINGS = new Set(['utf8', 'utf-8']);

const THIS_FILE_QUOTING_THE_PATTERNS = 'pluginBinaryScan.test.ts';

const isTextEncoding = (node: ts.Node): boolean =>
  ts.isStringLiteralLike(node) && TEXT_ENCODINGS.has(node.text.toLowerCase());

function statesATextEncoding(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false;
  if (ts.isStringLiteralLike(argument)) return isTextEncoding(argument);
  return ts.isObjectLiteralExpression(argument)
    && argument.properties.some((p) =>
      ts.isPropertyAssignment(p) && p.name.getText() === 'encoding' && isTextEncoding(p.initializer));
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)
    || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const LOSSLESS_DECODER_OPTIONS = ['fatal', 'ignoreBOM'];

const setsEachTrue = (node: ts.Expression | undefined, names: readonly string[]): boolean =>
  node !== undefined && ts.isObjectLiteralExpression(node) && node.properties.length === names.length
  && names.every((name) => node.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === name && p.initializer.kind === ts.SyntaxKind.TrueKeyword));

const isLosslessUtf8Decoder = (node: ts.Expression): boolean => {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'TextDecoder') return false;
  const [label, options, ...rest] = node.arguments ?? [];
  return rest.length === 0 && label !== undefined && isTextEncoding(label) && setsEachTrue(options, LOSSLESS_DECODER_OPTIONS);
};

function decodedOnArrival(read: ts.CallExpression): boolean {
  let current: ts.Node = read;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAwaitExpression(current.parent)) current = current.parent;
  const { parent } = current;
  return ts.isCallExpression(parent) && parent.arguments[0] === current && ts.isPropertyAccessExpression(parent.expression)
    && parent.expression.name.text === 'decode' && isLosslessUtf8Decoder(unwrap(parent.expression.expression));
}

const MAY_READ_FILES = new RegExp([...DECODING_READS].join('|'));

function undecodedReadsIn(sourceText: string, fileName: string): string[] {
  if (!MAY_READ_FILES.test(sourceText)) return [];
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const undecodedReads: string[] = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
      : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    if (callee !== undefined && DECODING_READS.has(callee) && !statesATextEncoding(node.arguments[1]) && !decodedOnArrival(node)) {
      undecodedReads.push(callee);
    }
  });
  return undecodedReads;
}

interface ByteReader {
  readonly imports: Readonly<Record<string, ReadonlySet<string>>>;
  readonly exports: ReadonlySet<string>;
  readonly exportReturns: string;
  readonly exportedTypes?: ReadonlySet<string>;
}

const DIGEST: ByteReader = {
  imports: { 'node:fs': new Set(['createReadStream']), 'node:crypto': new Set(['createHash']), 'xxhash-wasm': new Set(['default']) },
  exports: new Set(['digestOf', 'md5Of', 'textHash']),
  exportReturns: 'Promise<string>',
};

const VERSION_READ: ByteReader = {
  imports: { 'node:fs/promises': new Set(['open']) },
  exports: new Set(['versionResourceOf']),
  exportReturns: 'Promise<VersionResource>',
  exportedTypes: new Set(['VersionResource']),
};

const FOMOD_XML_READ: ByteReader = {
  imports: { 'node:fs/promises': new Set(['readFile']), '../../ports/errno': new Set(['errnoCode']) },
  exports: new Set(['releaseXmlText']),
  exportReturns: 'Promise<string>',
};

const STEAM_SHORTCUTS_READ: ByteReader = {
  imports: { 'node:fs/promises': new Set(['readFile']), '../../ports/errno': new Set(['errnoCode']) },
  exports: new Set(['shortcutsAt']),
  exportReturns: 'Promise<Shortcut[]>',
  exportedTypes: new Set(['Shortcut']),
};

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const firstLine = (node: ts.Node): string => present(node.getText().split('\n')[0], 'a statement\'s first line');

function importOffences(statement: ts.ImportDeclaration, imports: ByteReader['imports']): string[] {
  const from = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : firstLine(statement);
  const allowed = imports[from];
  if (allowed === undefined) return [`imports ${from}`];
  const clause = statement.importClause;
  const bindings = clause?.namedBindings;
  if (clause === undefined || (bindings !== undefined && !ts.isNamedImports(bindings))) return [`imports ${from} whole`];
  const names = [...(clause.name ? ['default'] : []), ...(bindings?.elements.map((e) => (e.propertyName ?? e.name).text) ?? [])];
  return names.filter((name) => !allowed.has(name)).map((name) => `imports ${name} from ${from}`);
}

function byteReaderOffences(reader: ByteReader, sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const offences: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      offences.push(...importOffences(statement, reader.imports));
    } else if (ts.isFunctionDeclaration(statement) && reader.exports.has(statement.name?.text ?? '') && isExported(statement)) {
      const returns = statement.type?.getText() ?? 'nothing declared';
      if (returns !== reader.exportReturns) offences.push(`${statement.name?.text} returns ${returns}, not ${reader.exportReturns}`);
    } else if (ts.isTypeAliasDeclaration(statement) && reader.exportedTypes?.has(statement.name.text) === true) {
      continue;
    } else if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) || isExported(statement)) {
      offences.push(firstLine(statement));
    }
  }
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const acquires = node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
    if (acquires) offences.push(`imports ${node.arguments[0] !== undefined ? firstLine(node.arguments[0]).replace(/^['"]|['"]$/g, '') : ''}`);
  });
  return offences;
}

const BYTE_READERS: readonly (readonly [string, ByteReader])[] = [
  [join('instanceAdapter', 'fileContents', 'contentDigest.ts'), DIGEST],
  [join('instanceAdapter', 'gameFolder', 'versionResource.ts'), VERSION_READ],
  [join('instanceAdapter', 'fomodInstaller', 'releaseXml.ts'), FOMOD_XML_READ],
  [join('instanceAdapter', 'gameFolder', 'steamShortcuts.ts'), STEAM_SHORTCUTS_READ],
];
const isByteReader = (path: string): boolean => BYTE_READERS.some(([reader]) => reader === relative(SRC, path));

const FOMOD_INSTALLER = join('instanceAdapter', 'fomodInstaller');
const FOMOD_XML_READ_MODULE = join(FOMOD_INSTALLER, 'releaseXml');

function modulesImported(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  walk(source, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const [specifier] = node.arguments;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
    }
  });
  return specifiers.filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => relative(SRC, join(dirname(fileName), specifier)).replace(/\.ts$/, ''));
}

const importsTheFomodXmlReadFromOutside = (sourceText: string, fileName: string): boolean =>
  !relative(SRC, fileName).startsWith(`${FOMOD_INSTALLER}${sep}`) && modulesImported(sourceText, fileName).includes(FOMOD_XML_READ_MODULE);

describe('the extension interprets no plugin binary (ADR-0004): its byte-level reads, in the digest module, the Game folder\'s version read, the FOMOD installer\'s XML read and Steam\'s shortcuts read, feed a hash, a program\'s version, a FOMOD\'s text or a Steam shortcut, and nothing else', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC, { exclude: ['generated'] }).length).toBeGreaterThan(100);
  });

  it('decodes every file it reads outside those four, so no production read can yield a plugin\'s bytes', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC, { exclude: ['generated'] })) {
      if (basename(path) === THIS_FILE_QUOTING_THE_PATTERNS || isTestSupport(relative(SRC, path)) || isByteReader(path)) continue;
      const undecodedReads = undecodedReadsIn(readFileSync(path, 'utf8'), path);
      if (undecodedReads.length > 0) offenders[path] = undecodedReads;
    }
    expect(offenders).toEqual({});
  });

  it.each(BYTE_READERS)('holds %s to its imports and its exports, so its bytes reach only what it answers', (path, reader) => {
    expect(byteReaderOffences(reader, readFileSync(join(SRC, path), 'utf8'), path)).toEqual([]);
  });

  it('lets only the FOMOD installer import its XML read, whose Windows-1252 fallback answers any file whole', () => {
    const importers = tsFiles(SRC, { exclude: ['generated'] })
      .filter((path) => !isTestSupport(relative(SRC, path)) && importsTheFomodXmlReadFromOutside(readFileSync(path, 'utf8'), path));
    expect(importers).toEqual([]);
  });

  it.each([
    "import { releaseXmlText } from '../fomodInstaller/releaseXml';",
    "export { releaseXmlText } from '../fomodInstaller/releaseXml.ts';",
    "const { releaseXmlText } = await import('../fomodInstaller/releaseXml');",
  ])('flags `%s` outside the FOMOD installer, and not inside it', (planted) => {
    expect(importsTheFomodXmlReadFromOutside(planted, join(SRC, 'instanceAdapter', 'mo2', 'planted.ts'))).toBe(true);
    expect(importsTheFomodXmlReadFromOutside(planted.replace('../fomodInstaller/', './'), join(SRC, FOMOD_INSTALLER, 'planted.ts'))).toBe(false);
  });

  it.each([
    ['a version read that reads a whole file, or exports a buffer or a type it does not answer with', VERSION_READ, 'versionResource.ts',
      "import { open, readFile } from 'node:fs/promises';\nexport type Bytes = Buffer;\nexport async function versionResourceOf(p): Promise<Buffer> {}\n",
      ['imports readFile from node:fs/promises', 'export type Bytes = Buffer;', 'versionResourceOf returns Promise<Buffer>, not Promise<VersionResource>']],
    ['a digest module that imports a module beside the xxHash package and createReadStream, which could carry the bytes elsewhere', DIGEST, 'contentDigest.ts',
      "import xxhash from 'xxhash-wasm';\nimport { createReadStream } from 'node:fs';\nimport { keep } from './layout';\nexport async function digestOf(p): Promise<string> { keep(p); }\n",
      ['imports ./layout']],
    ['a digest module that imports a sibling of createReadStream', DIGEST, 'contentDigest.ts',
      "import { createReadStream, writeFileSync } from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\n", ['imports writeFileSync from node:fs']],
    ['a digest module that imports node:fs whole', DIGEST, 'contentDigest.ts',
      "import * as fs from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\n", ['imports node:fs whole']],
    ['a digest module that imports node:fs by default', DIGEST, 'contentDigest.ts',
      "import fs from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\n", ['imports default from node:fs']],
    ['an import acquired in the body by a dynamic import, which the import list does not show', DIGEST, 'contentDigest.ts',
      "export async function digestOf(p): Promise<string> { const { keep } = await import('./layout'); }\n", ['imports ./layout']],
    ['an import acquired in the body by require, which the import list does not show', DIGEST, 'contentDigest.ts',
      "export async function digestOf(p): Promise<string> { const { keep } = require('./layout'); }\n", ['imports ./layout']],
    ['a hash other than digestOf that answers anything but a string', DIGEST, 'contentDigest.ts',
      'export async function md5Of(p): Promise<Buffer> {}\n', ['md5Of returns Promise<Buffer>, not Promise<string>']],
    ['a second named export, which is a second way out for the bytes', DIGEST, 'contentDigest.ts',
      "import { createReadStream } from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\nexport const bytesOf = (p) => createReadStream(p);\n",
      ['export const bytesOf = (p) => createReadStream(p);']],
    ['a second export as the default', DIGEST, 'contentDigest.ts',
      "import { createReadStream } from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\nexport default createReadStream;\n", ['export default createReadStream;']],
    ['a second export re-exported from another module', DIGEST, 'contentDigest.ts',
      "export async function digestOf(p): Promise<string> {}\nexport { createReadStream } from 'node:fs';\n", ["export { createReadStream } from 'node:fs';"]],
    ['a digestOf that declares no answer, so the bytes could leave as its answer', DIGEST, 'contentDigest.ts',
      'export async function digestOf(p) {}\n', ['digestOf returns nothing declared, not Promise<string>']],
    ['a digestOf that answers a buffer', DIGEST, 'contentDigest.ts',
      'export function digestOf(p): Promise<Buffer> {}\n', ['digestOf returns Promise<Buffer>, not Promise<string>']],
  ])('flags %s', (_, reader, file, planted, offences) => {
    expect(byteReaderOffences(reader, planted, file)).toEqual(offences);
  });

  it('flags a header read taken as a Buffer from an undecoded readFile', () => {
    const planted = "import { readFile } from 'node:fs/promises';\nexport const m = async (p) => (await readFile(p)).subarray(0, 24);\n";
    expect(undecodedReadsIn(planted, 'masterReader.ts')).toEqual(['readFile']);
  });

  it('flags a byte-preserving encoding, which is a byte read wearing an encoding argument', () => {
    const planted = "readFile(p, 'latin1');\nreadFileSync(p, { encoding: 'binary' });\nreadFile(p, 'hex');\nreadFile(p, 'base64');\n";
    expect(undecodedReadsIn(planted, 'masterReader.ts')).toEqual(['readFile', 'readFileSync', 'readFile', 'readFile']);
  });

  it('does not flag a text-decoded read, by argument or by options object', () => {
    const decoded = "readFile(p, 'utf8');\nreadFileSync(p, { encoding: 'utf-8' });\n";
    expect(undecodedReadsIn(decoded, 'x.ts')).toEqual([]);
  });

  it('does not flag a read that takes no encoding, as VS Code\'s does, handed straight to a UTF-8 TextDecoder that refuses what is not text and keeps a byte order mark', () => {
    const decoded = "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await vscode.workspace.fs.readFile(u));\n"
      + "new TextDecoder('utf8', { ignoreBOM: true, fatal: true }).decode(await fs.readFile(u));\n";
    expect(undecodedReadsIn(decoded, 'x.ts')).toEqual([]);
  });

  it('flags a read whose bytes are kept, or decoded by a TextDecoder that replaces what is not text, preserves bytes or drops a byte order mark, or by any other decoder', () => {
    const planted = [
      'const bytes = await vscode.workspace.fs.readFile(u);',
      'new TextDecoder().decode(await readFile(p));',
      "new TextDecoder('utf-8').decode(await readFile(p));",
      "new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(await readFile(p));",
      "new TextDecoder('utf-8', { fatal: true }).decode(await readFile(p));",
      "new TextDecoder('latin1', { fatal: true, ignoreBOM: true }).decode(await readFile(p));",
      "headerParser.decode(await readFile(p));",
    ].join('\n');
    expect(undecodedReadsIn(planted, 'masterReader.ts')).toEqual(Array(7).fill('readFile'));
  });

});
