import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { productionFiles, SRC } from './scanSource';

const SEAM_BOXES = ['wire', 'client'];
const PLUGIN_NAME = /^(.*?)(plugin|pluginName|fileName)$/i;

interface Member { name: string; isString: boolean }

const isString = (type: ts.TypeNode | undefined): boolean =>
  type?.kind === ts.SyntaxKind.StringKeyword
  || (type !== undefined && ts.isUnionTypeNode(type) && type.types.some((t) => t.kind === ts.SyntaxKind.StringKeyword));

const member = (name: ts.Node, type: ts.TypeNode | undefined): Member[] =>
  (ts.isIdentifier(name) ? [{ name: name.text, isString: isString(type) }] : []);

function siblings(node: ts.Node): Member[] {
  if (ts.isFunctionLike(node)) return node.parameters.flatMap((p) => member(p.name, p.type));
  if (!ts.isTypeLiteralNode(node) && !ts.isInterfaceDeclaration(node)) return [];
  return node.members.flatMap((m) => (ts.isPropertySignature(m) ? member(m.name, m.type) : []));
}

function pluginNamesWithoutOrigin(members: Member[]): string[] {
  return members.filter((m) => m.isString).flatMap(({ name }) => {
    const match = PLUGIN_NAME.exec(name);
    if (!match) return [];
    const origin = `${match[1]}origin`.toLowerCase();
    return members.some((m) => m.name.toLowerCase() === origin) ? [] : [name];
  });
}

function seamFiles(src: string = SRC): string[] {
  return SEAM_BOXES.flatMap((box) => productionFiles(join(src, box)))
    .filter((path) => !relative(src, path).split(sep).includes('generated'));
}

function findOffenders(src: string = SRC): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const path of seamFiles(src)) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      found.push(...pluginNamesWithoutOrigin(siblings(node)));
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found.length > 0) offenders[relative(src, path)] = found;
  }
  return offenders;
}

async function plantedSeams(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'medit-plugin-identity-scan-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe('a plugin name crosses a Modbench seam with its origin beside it (ADR-0012)', () => {
  it('scans the webview protocol and the mEdit client port', () => {
    expect(seamFiles()).toEqual(expect.arrayContaining([join(SRC, 'wire', 'messages.ts'), join(SRC, 'client', 'MEditClient.ts')]));
  });

  it('the seams as they stand carry an origin beside every plugin name', () => {
    expect(findOffenders()).toEqual({});
  });

  it('flags a string plugin or filename with no origin of its own prefix in the same member or parameter list', async () => {
    const dir = await plantedSeams({
      [join('wire', 'newMessage.ts')]: [
        'export interface Bare { plugin: string; formKey: string }',
        'export type Paired = { plugin: string; origin: string };',
        'export type Prefixed = { sourcePlugin: string; sourceOrigin: string; destinationPlugin: string };',
        'export type Nullable = { readonly pluginName?: string | null };',
        'export type Nested = { origin: string; record: { plugin: string } };',
        'export type Typed = { plugin: PluginAddress; plugins: string[] };',
        '',
      ].join('\n'),
      [join('client', 'port.ts')]: [
        'export interface Port {',
        '  read(fileName: string, origin: string): void;',
        '  write(fileName: string, text: string): void;',
        '  listen(listener: (plugin: string) => void): void;',
        '}',
        'export class Adapter { constructor(readonly plugin: string) {} }',
        '',
      ].join('\n'),
      [join('client', 'test', 'fixture.ts')]: 'export const bare = (plugin: string) => plugin;\n',
      [join('plugins', 'outsideTheSeams.ts')]: 'export const bare = (plugin: string) => plugin;\n',
    });
    try {
      expect(findOffenders(dir)).toEqual({
        [join('wire', 'newMessage.ts')]: ['plugin', 'destinationPlugin', 'pluginName', 'plugin'],
        [join('client', 'port.ts')]: ['fileName', 'plugin', 'plugin'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
