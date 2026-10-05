import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import ts from 'typescript';
import { present } from '../ports/present';
import { isTestSupport, SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const BYTE_READS = new Set(['open', 'openSync', 'openAsBlob', 'createReadStream', 'read', 'readSync', 'readv', 'readvSync']);

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

const DECODING_READS = new Set(['readFile', 'readFileSync']);

const TEXT_ENCODINGS = new Set(['utf8', 'utf-8']);

const THIS_FILE_QUOTING_THE_PATTERNS = 'pluginBinaryScan.test.ts';

interface Offences {
  byteReads: string[];
  undecodedReads: string[];
}

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

function fsModuleAcquired(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
  if (!dynamic || node.arguments.length === 0) return undefined;
  const specifier = present(node.arguments[0], 'the call expression\'s first argument');
  return ts.isStringLiteralLike(specifier) && FS_MODULES.has(specifier.text) ? specifier.text : undefined;
}

const isFsModule = (node: ts.Expression, aliases: ReadonlySet<string>): boolean => {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) ? aliases.has(inner.text) : fsModuleAcquired(inner) !== undefined;
};

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const fsSpecifierOf = (node: ts.ImportDeclaration): string | undefined =>
  ts.isStringLiteralLike(node.moduleSpecifier) && FS_MODULES.has(node.moduleSpecifier.text)
    ? node.moduleSpecifier.text : undefined;

function fsAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  for (let size = -1; size !== aliases.size;) {
    size = aliases.size;
    walk(source, (node) => {
      if (ts.isImportDeclaration(node) && fsSpecifierOf(node) !== undefined && node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
        const clause = node.importClause;
        if (clause?.name) aliases.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) aliases.add(clause.namedBindings.name.text);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && FS_MODULES.has(node.moduleReference.expression.text)) {
        aliases.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && isFsModule(node.initializer, aliases)) {
        if (ts.isIdentifier(node.name)) aliases.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (element.dotDotDotToken && ts.isIdentifier(element.name)) aliases.add(element.name.text);
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && isFsModule(node.right, aliases)) {
        aliases.add(node.left.text);
      }
    });
  }
  return aliases;
}

const PROMISE_COMBINATORS = new Set(['then', 'catch', 'finally']);

const memberRead = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined =>
  ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;

function acquisitionIsFollowed(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAwaitExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)) {
    current = current.parent;
  }
  const { parent } = current;
  if (ts.isVariableDeclaration(parent) && parent.initializer === current) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) {
    const member = memberRead(parent);
    return member !== undefined && !PROMISE_COMBINATORS.has(member);
  }
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === current;
}

const memberLabel = (expression: ts.Expression, member: string): string => {
  const inner = unwrap(expression);
  return ts.isIdentifier(inner) ? `${inner.text}.${member}` : member;
};

function boundExport(element: ts.BindingElement): string | undefined {
  if (element.propertyName !== undefined) {
    return ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined;
  }
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

const MAY_READ_FILES = new RegExp(`['"\`](?:${[...FS_MODULES].join('|')})['"\`]|${[...DECODING_READS].join('|')}`);

function scan(sourceText: string, fileName: string): Offences {
  if (!MAY_READ_FILES.test(sourceText)) return { byteReads: [], undecodedReads: [] };
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const aliases = fsAliases(source);
  const byteReads: string[] = [];
  const undecodedReads: string[] = [];

  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && fsSpecifierOf(node) !== undefined && node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && BYTE_READS.has(imported)) byteReads.push(imported);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isFsModule(node.initializer, aliases)
      && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const exported = boundExport(element);
        if (exported !== undefined && BYTE_READS.has(exported)) byteReads.push(exported);
      }
    }
    if (ts.isPropertyAccessExpression(node) && isFsModule(node.expression, aliases)
      && BYTE_READS.has(node.name.text)) {
      byteReads.push(memberLabel(node.expression, node.name.text));
    }
    if (ts.isElementAccessExpression(node) && isFsModule(node.expression, aliases)
      && ts.isStringLiteralLike(node.argumentExpression) && BYTE_READS.has(node.argumentExpression.text)) {
      byteReads.push(memberLabel(node.expression, node.argumentExpression.text));
    }
    const acquired = fsModuleAcquired(node);
    if (acquired !== undefined && !acquisitionIsFollowed(node)) byteReads.push(`dynamic ${acquired}`);
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      if (callee !== undefined && DECODING_READS.has(callee) && !statesATextEncoding(node.arguments[1])) {
        undecodedReads.push(callee);
      }
    }
  });
  return { byteReads, undecodedReads };
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

describe('the extension interprets no plugin binary (ADR-0004): its one byte-level read feeds a hash, through the bindings a static scan follows', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC, { exclude: ['generated'] }).length).toBeGreaterThan(100);
  });

  it('reaches no byte-level fs read anywhere in src but the Instance adapter\'s digest', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC, { exclude: ['generated'] })) {
      if (basename(path) === THIS_FILE_QUOTING_THE_PATTERNS || path === THE_DIGEST) continue;
      const { byteReads } = scan(readFileSync(path, 'utf8'), path);
      if (byteReads.length > 0) offenders[path] = byteReads;
    }
    expect(offenders).toEqual({});
  });

  it('decodes every file it reads, so no production read can yield a plugin\'s bytes', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC, { exclude: ['generated'] })) {
      if (basename(path) === THIS_FILE_QUOTING_THE_PATTERNS || isTestSupport(relative(SRC, path))) continue;
      const { undecodedReads } = scan(readFileSync(path, 'utf8'), path);
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

  it('flags a restored header read through an fs handle', () => {
    const planted = "import { open } from 'node:fs/promises';\nexport const h = () => open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  it('flags a header read reached through a namespace import of node:fs', () => {
    const planted = "import * as fs from 'node:fs/promises';\nexport const h = () => fs.open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['fs.open']);
  });

  it('flags a header read taken as a Buffer from an undecoded readFile', () => {
    const planted = "import { readFile } from 'node:fs/promises';\nexport const m = async (p) => (await readFile(p)).subarray(0, 24);\n";
    expect(scan(planted, 'masterReader.ts').undecodedReads).toEqual(['readFile']);
  });

  it('flags a byte-preserving encoding, which is a byte read wearing an encoding argument', () => {
    const planted = "readFile(p, 'latin1');\nreadFileSync(p, { encoding: 'binary' });\nreadFile(p, 'hex');\nreadFile(p, 'base64');\n";
    expect(scan(planted, 'masterReader.ts').undecodedReads).toEqual(['readFile', 'readFileSync', 'readFile', 'readFile']);
  });

  it('does not flag a text-decoded read, by argument or by options object', () => {
    const decoded = "readFile(p, 'utf8');\nreadFileSync(p, { encoding: 'utf-8' });\n";
    expect(scan(decoded, 'x.ts').undecodedReads).toEqual([]);
  });

  it('flags a header read through a dynamically imported namespace', () => {
    const planted = "const fs = await import('node:fs');\nexport const h = () => fs.createReadStream(p);\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['fs.createReadStream']);
  });

  it('flags a header read destructured out of a dynamic import', () => {
    const planted = "const { open } = await import('node:fs/promises');\nexport const h = () => open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  it('flags a header read through a specifier written as a template literal', () => {
    const planted = "const { open } = await import(`node:fs/promises`);\nexport const h = () => open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  it('flags a header read through require, by namespace and by destructuring', () => {
    const namespaced = "const fs = require('node:fs');\nexport const h = () => fs.openSync(p);\n";
    expect(scan(namespaced, 'masterReader.ts').byteReads).toEqual(['fs.openSync']);
    const destructured = "const { open } = require('node:fs/promises');\nexport const h = () => open(p, 'r');\n";
    expect(scan(destructured, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  it('follows an alias of an alias, so renaming the binding hides nothing', () => {
    const planted = "import * as fs from 'node:fs';\nconst g = fs;\nexport const h = () => g.open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['g.open']);
  });

  it('follows an alias declared after the alias that reads it', () => {
    const planted = "import * as fs from 'node:fs';\nconst a = b;\nconst b = fs;\nexport const h = () => a.open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['a.open']);
  });

  it('flags a rest element of a destructured module, which holds every export', () => {
    const planted = "const { ...rest } = await import('node:fs/promises');\nexport const h = () => rest.open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['rest.open']);
  });

  it('flags a member read straight off the acquisition, which binds no name at all', () => {
    const planted = "export const h = async () => (await import('node:fs')).createReadStream(p);\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['createReadStream']);
  });

  it('flags a computed member read, which spells the name in a string', () => {
    const planted = "import * as fs from 'node:fs';\nexport const h = () => fs['open'](p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['fs.open']);
  });

  it('flags a rename on destructuring, since the export is what was taken', () => {
    const planted = "const { open: acquire } = await import('node:fs/promises');\nexport const h = () => acquire(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  it('flags an acquisition whose value it cannot follow, rather than letting the flow escape', () => {
    const callback = "export const h = () => import('node:fs').then((fs) => fs.open(p, 'r'));\n";
    expect(scan(callback, 'masterReader.ts').byteReads).toEqual(['dynamic node:fs']);
    const returned = "export const load = () => import('node:fs/promises');\n";
    expect(scan(returned, 'masterReader.ts').byteReads).toEqual(['dynamic node:fs/promises']);
  });

  it('flags openAsBlob, which yields a file\'s bytes through a Blob', () => {
    const planted = "import { openAsBlob } from 'node:fs';\nexport const h = async () => (await openAsBlob(p)).stream();\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['openAsBlob']);
  });

  it('does not flag a type-only import, which calls nothing', () => {
    const typeOnly = "import type { FileHandle } from 'node:fs/promises';\nexport type H = FileHandle;\n";
    expect(scan(typeOnly, 'x.ts').byteReads).toEqual([]);
    const inlineType = "import { type open } from 'node:fs/promises';\nexport type O = typeof open;\n";
    expect(scan(inlineType, 'x.ts').byteReads).toEqual([]);
  });

  it('does not flag an import used only as a type', () => {
    const asType = "type ReadFile = typeof import('node:fs/promises')['readFile'];\nexport type R = ReadFile;\n";
    expect(scan(asType, 'x.test.ts').byteReads).toEqual([]);
  });

  it('does not flag a dynamic import of a module that is not node:fs', () => {
    const other = "export const h = async () => (await import('node:path')).join(a, b);\n";
    expect(scan(other, 'x.ts').byteReads).toEqual([]);
  });

  it('does not flag a directory listing or a stat, which read no file content', () => {
    const listing = "import { readdir, stat } from 'node:fs/promises';\nreaddir(d);\nstat(f);\n";
    expect(scan(listing, 'x.ts').byteReads).toEqual([]);
  });
});
