import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { catalogCommandIds, GESTURES_MARKDOWN } from './commandsCatalog';
import { plantedTree, productionFiles, SRC } from './scanSource';

const GATES = new Set(['holdingTheWrite', 'runWritingGesture', 'runModsWriting', 'runDownloadsWriting', 'movePlugins']);

const sourceOf = (path: string): ts.SourceFile => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

function stringConstants(files: readonly ts.SourceFile[]): Map<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return constants;
}

function gatedCommands(files: readonly ts.SourceFile[]): Set<string> {
  const constants = stringConstants(files);
  const gated = new Set<string>();
  const named = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) gated.add(node.text);
    else if (ts.isIdentifier(node) && constants.has(node.text)) gated.add(constants.get(node.text) ?? '');
    else ts.forEachChild(node, named);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && GATES.has(node.expression.text) && node.arguments[0] !== undefined) {
      named(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return gated;
}

const ungatedWrites = (root: string, writes: Iterable<string>): string[] => {
  const gated = gatedCommands(productionFiles(root).map(sourceOf));
  return [...writes].filter((id) => !gated.has(id)).sort();
};

describe('every gesture whose Effect is writes holds the one write at a time (commands.md, Refuse, do not repair)', () => {
  it('is gated by a write gate under its Command ID', () => {
    expect(ungatedWrites(SRC, catalogCommandIds(GESTURES_MARKDOWN, 'writes'))).toEqual([]);
  });

  it('flags a write whose command runs under no gate', () => {
    const root = plantedTree({
      'a.ts': "const GATED = 'modbench.a.gated';\nrunWritingGesture(GATED, view, instance, run);\nrunModsWriting(x ? 'modbench.a.one' : 'modbench.a.two', instance, run);\n",
    });

    expect(ungatedWrites(root, ['modbench.a.gated', 'modbench.a.one', 'modbench.a.two', 'modbench.a.bare'])).toEqual(['modbench.a.bare']);
  });
});
