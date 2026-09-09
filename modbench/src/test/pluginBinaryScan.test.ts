// ADR-0021: the extension parses no plugin binary. Every fact about a plugin's contents reaches
// it through the generated client, so nothing in src/ opens a file for its bytes.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, basename, sep } from 'node:path';
import ts from 'typescript';

// The `node:fs` entry points that hand back bytes rather than a directory listing or a decoded
// string. `readFile` is not among them — it is covered by the encoding rule below.
const BYTE_READS = new Set(['open', 'openSync', 'createReadStream', 'read', 'readSync', 'readv', 'readvSync']);

const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

const DECODING_READS = new Set(['readFile', 'readFileSync']);

// The encodings that decode text. `latin1`, `binary`, `hex` and `base64` preserve every byte, so
// a header parse survives them intact — they are byte reads wearing an encoding argument.
const TEXT_ENCODINGS = new Set(['utf8', 'utf-8']);

// This file necessarily names every forbidden binding as data, and plants each rival below.
const SELF = 'pluginBinaryScan.test.ts';

interface Offences {
  /** `node:fs` byte-read entry points this file can reach. */
  byteReads: string[];
  /** `readFile`/`readFileSync` calls that ask for bytes by omitting an encoding. */
  undecodedReads: string[];
}

const isTextEncoding = (node: ts.Node): boolean =>
  ts.isStringLiteralLike(node) && TEXT_ENCODINGS.has(node.text.toLowerCase());

// A text-encoding literal, or an options object whose `encoding` is one — either way the call
// yields decoded text, never a plugin's bytes.
function statesATextEncoding(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false;
  if (ts.isStringLiteralLike(argument)) return isTextEncoding(argument);
  return ts.isObjectLiteralExpression(argument)
    && argument.properties.some((p) =>
      ts.isPropertyAssignment(p) && p.name.getText() === 'encoding' && isTextEncoding(p.initializer));
}

// Strips the wrappers that leave a value unchanged, so `(await import('node:fs'))` reads as the
// module it resolves to.
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)
    || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

// `import('node:fs')` or `require('node:fs')` — reaching the module at run time, naming no import
// declaration for a scan to read. A type-position `import('node:fs')` is an ImportTypeNode, never
// a call, so it never lands here.
function fsModuleAcquired(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
  if (!dynamic || node.arguments.length === 0) return undefined;
  const specifier = node.arguments[0];
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

// Every name that holds the fs module. Iterated to a fixpoint, so an alias of an alias is one too
// and a binding declared after its use still counts.
function fsAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  for (let size = -1; size !== aliases.size;) {
    size = aliases.size;
    walk(source, (node) => {
      if (ts.isImportDeclaration(node) && fsSpecifierOf(node) !== undefined && node.importClause?.isTypeOnly !== true) {
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
            // `...rest` holds every remaining export, this module's byte reads included.
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

// `import()` answers a Promise, so reading one of these off an acquisition hands the module to a
// callback instead of naming a member of it.
const PROMISE_COMBINATORS = new Set(['then', 'catch', 'finally']);

const memberRead = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined =>
  ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;

// Whether an acquisition's value lands somewhere the passes above already read. A `.then(fs => …)`
// callback, a return, an argument — anything else — puts it beyond a scan that does no dataflow,
// which is why an unfollowed acquisition is itself reported.
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

// A destructuring element's own name in the module, which is what a rename binds away from.
function boundExport(element: ts.BindingElement): string | undefined {
  if (element.propertyName !== undefined) {
    return ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined;
  }
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

function scan(sourceText: string, fileName: string): Offences {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const aliases = fsAliases(source);
  const byteReads: string[] = [];
  const undecodedReads: string[] = [];

  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && fsSpecifierOf(node) !== undefined && node.importClause?.isTypeOnly !== true) {
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

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') out.push(path);
  }
  return out;
}

// A test file or a fixture helper under a `test/` folder: bytes there are compared, never
// interpreted, which is how a corpus snapshot proves two trees identical.
export function isTestSupport(path: string): boolean {
  return basename(path).includes('.test.') || path.split(sep).includes('test');
}

const SRC = join(__dirname, '..');

describe('the extension opens no plugin file for reading', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC).length).toBeGreaterThan(100);
  });

  it('reaches no byte-level fs read anywhere in src', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC)) {
      if (basename(path) === SELF) continue;
      const { byteReads } = scan(readFileSync(path, 'utf8'), path);
      if (byteReads.length > 0) offenders[path] = byteReads;
    }
    expect(offenders).toEqual({});
  });

  it('decodes every file it reads, so no production read can yield a plugin\'s bytes', () => {
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(SRC)) {
      if (basename(path) === SELF || isTestSupport(path)) continue;
      const { undecodedReads } = scan(readFileSync(path, 'utf8'), path);
      if (undecodedReads.length > 0) offenders[path] = undecodedReads;
    }
    expect(offenders).toEqual({});
  });

  // Rival: the TES4 header reader restored — a handle opened and its first bytes parsed.
  it('flags a restored header read through an fs handle', () => {
    const planted = "import { open } from 'node:fs/promises';\nexport const h = () => open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  // The same rival through a namespace import, which names no binding to match on.
  it('flags a header read reached through a namespace import of node:fs', () => {
    const planted = "import * as fs from 'node:fs/promises';\nexport const h = () => fs.open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['fs.open']);
  });

  // The same rival without a handle: `readFile` with no encoding hands back a Buffer to slice.
  it('flags a header read taken as a Buffer from an undecoded readFile', () => {
    const planted = "import { readFile } from 'node:fs/promises';\nexport const m = async (p) => (await readFile(p)).subarray(0, 24);\n";
    expect(scan(planted, 'masterReader.ts').undecodedReads).toEqual(['readFile']);
  });

  // The same rival with an encoding argument that decodes nothing: latin1 maps each byte to one
  // character, so a header parse survives it whole.
  it('flags a byte-preserving encoding, which is a byte read wearing an encoding argument', () => {
    const planted = "readFile(p, 'latin1');\nreadFileSync(p, { encoding: 'binary' });\n";
    expect(scan(planted, 'masterReader.ts').undecodedReads).toEqual(['readFile', 'readFileSync']);
  });

  it('does not flag a text-decoded read, by argument or by options object', () => {
    const decoded = "readFile(p, 'utf8');\nreadFileSync(p, { encoding: 'utf-8' });\n";
    expect(scan(decoded, 'x.ts').undecodedReads).toEqual([]);
  });

  // The same rival one route over: a dynamic import names no ImportDeclaration, so a scan that
  // only reads static imports never sees the binding.
  it('flags a header read through a dynamically imported namespace', () => {
    const planted = "const fs = await import('node:fs');\nexport const h = () => fs.createReadStream(p);\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['fs.createReadStream']);
  });

  it('flags a header read destructured out of a dynamic import', () => {
    const planted = "const { open } = await import('node:fs/promises');\nexport const h = () => open(p, 'r');\n";
    expect(scan(planted, 'masterReader.ts').byteReads).toEqual(['open']);
  });

  // `require` names no import declaration either, and the bundler still resolves it.
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

  // The routes no scan can follow without dataflow — a callback parameter, an argument, a return.
  // The acquisition itself is the offence there, so the class is closed rather than left silent.
  it('flags an acquisition whose value it cannot follow, rather than letting the flow escape', () => {
    const callback = "export const h = () => import('node:fs').then((fs) => fs.open(p, 'r'));\n";
    expect(scan(callback, 'masterReader.ts').byteReads).toEqual(['dynamic node:fs']);
    const returned = "export const load = () => import('node:fs/promises');\n";
    expect(scan(returned, 'masterReader.ts').byteReads).toEqual(['dynamic node:fs/promises']);
  });

  it('does not flag a type-only import, which calls nothing', () => {
    const typeOnly = "import type { FileHandle } from 'node:fs/promises';\nexport type H = FileHandle;\n";
    expect(scan(typeOnly, 'x.ts').byteReads).toEqual([]);
    const inlineType = "import { type open } from 'node:fs/promises';\nexport type O = typeof open;\n";
    expect(scan(inlineType, 'x.ts').byteReads).toEqual([]);
  });

  // A real shape in this tree (`commands/modlist.test.ts`): an import in type position is an
  // ImportTypeNode, not a call, so it acquires nothing at run time.
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

  it('holds the undecoded-read rule to production files, exempting test support', () => {
    expect(isTestSupport(join('src', 'modmanager', 'test', 'corpusFixture.ts'))).toBe(true);
    expect(isTestSupport(join('src', 'modmanager', 'instance.test.ts'))).toBe(true);
    expect(isTestSupport(join('src', 'modmanager', 'instance.ts'))).toBe(false);
  });
});
