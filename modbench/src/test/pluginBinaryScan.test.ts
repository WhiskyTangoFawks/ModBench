import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
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

const DIGEST_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'node:fs': new Set(['createReadStream']),
  'node:crypto': new Set(['createHash']),
};
const DIGEST_EXPORT = 'digestOf';
const DIGEST_RETURNS = 'Promise<string>';

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const firstLine = (node: ts.Node): string => present(node.getText().split('\n')[0], 'a statement\'s first line');

function importOffences(statement: ts.ImportDeclaration): string[] {
  const from = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : firstLine(statement);
  const allowed = DIGEST_IMPORTS[from];
  if (allowed === undefined) return [`imports ${from}`];
  const bindings = statement.importClause?.namedBindings;
  if (statement.importClause?.name || bindings === undefined || !ts.isNamedImports(bindings)) return [`imports ${from} whole`];
  return bindings.elements.map((e) => (e.propertyName ?? e.name).text).filter((name) => !allowed.has(name))
    .map((name) => `imports ${name} from ${from}`);
}

function digestModuleOffences(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const offences: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      offences.push(...importOffences(statement));
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === DIGEST_EXPORT && isExported(statement)) {
      const returns = statement.type?.getText() ?? 'nothing declared';
      if (returns !== DIGEST_RETURNS) offences.push(`${DIGEST_EXPORT} returns ${returns}, not ${DIGEST_RETURNS}`);
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

const THE_DIGEST = join(SRC, 'instanceAdapter', 'contentDigest.ts');

describe('the extension interprets no plugin binary (ADR-0004): its one byte-level read feeds a hash', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC, { exclude: ['generated'] }).length).toBeGreaterThan(100);
  });

  it('decodes every file it reads, so no production read can yield a plugin\'s bytes', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC, { exclude: ['generated'] })) {
      if (basename(path) === THIS_FILE_QUOTING_THE_PATTERNS || isTestSupport(relative(SRC, path))) continue;
      const undecodedReads = undecodedReadsIn(readFileSync(path, 'utf8'), path);
      if (undecodedReads.length > 0) offenders[path] = undecodedReads;
    }
    expect(offenders).toEqual({});
  });

  it('holds the digest module to node:fs, node:crypto and one exported function, so its bytes reach only a hash', () => {
    expect(digestModuleOffences(readFileSync(THE_DIGEST, 'utf8'), THE_DIGEST)).toEqual([]);
  });

  it('flags a digest module that imports anything but createReadStream and createHash, which could carry the bytes elsewhere', () => {
    const other = "import { createHash } from 'node:crypto';\nimport { createReadStream } from 'node:fs';\nimport { keep } from './layout';\nexport async function digestOf(p): Promise<string> { keep(p); }\n";
    expect(digestModuleOffences(other, 'contentDigest.ts')).toEqual(['imports ./layout']);
    const sibling = "import { createReadStream, writeFileSync } from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\n";
    expect(digestModuleOffences(sibling, 'contentDigest.ts')).toEqual(['imports writeFileSync from node:fs']);
    const whole = "import * as fs from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\n";
    expect(digestModuleOffences(whole, 'contentDigest.ts')).toEqual(['imports node:fs whole']);
  });

  it('flags an import acquired in the body, which the import list does not show', () => {
    const dynamic = "export async function digestOf(p): Promise<string> { const { keep } = await import('./layout'); }\n";
    expect(digestModuleOffences(dynamic, 'contentDigest.ts')).toEqual(['imports ./layout']);
    const required = "export async function digestOf(p): Promise<string> { const { keep } = require('./layout'); }\n";
    expect(digestModuleOffences(required, 'contentDigest.ts')).toEqual(['imports ./layout']);
  });

  it('flags a second export of any form, which is a second way out for the bytes', () => {
    const named = "import { createReadStream } from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\nexport const bytesOf = (p) => createReadStream(p);\n";
    expect(digestModuleOffences(named, 'contentDigest.ts')).toEqual(['export const bytesOf = (p) => createReadStream(p);']);
    const assigned = "import { createReadStream } from 'node:fs';\nexport async function digestOf(p): Promise<string> {}\nexport default createReadStream;\n";
    expect(digestModuleOffences(assigned, 'contentDigest.ts')).toEqual(['export default createReadStream;']);
    const reExported = "export async function digestOf(p): Promise<string> {}\nexport { createReadStream } from 'node:fs';\n";
    expect(digestModuleOffences(reExported, 'contentDigest.ts')).toEqual(["export { createReadStream } from 'node:fs';"]);
  });

  it('flags a digestOf that does not declare Promise<string>, so the bytes cannot leave as its answer', () => {
    const undeclared = "export async function digestOf(p) {}\n";
    expect(digestModuleOffences(undeclared, 'contentDigest.ts')).toEqual(['digestOf returns nothing declared, not Promise<string>']);
    const buffer = "export function digestOf(p): Promise<Buffer> {}\n";
    expect(digestModuleOffences(buffer, 'contentDigest.ts')).toEqual(['digestOf returns Promise<Buffer>, not Promise<string>']);
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
