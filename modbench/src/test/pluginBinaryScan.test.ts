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

function scan(sourceText: string, fileName: string): Offences {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const byteReads: string[] = [];
  const undecodedReads: string[] = [];
  // Namespace and default imports of node:fs, so `fs.open(…)` is caught alongside a named import.
  const fsNamespaces = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
      && FS_MODULES.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) fsNamespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        fsNamespaces.add(clause.namedBindings.name.text);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (BYTE_READS.has(imported)) byteReads.push(imported);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && fsNamespaces.has(node.expression.text) && BYTE_READS.has(node.name.text)) {
      byteReads.push(`${node.expression.text}.${node.name.text}`);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
        : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      if (callee !== undefined && DECODING_READS.has(callee) && !statesATextEncoding(node.arguments[1])) {
        undecodedReads.push(callee);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
