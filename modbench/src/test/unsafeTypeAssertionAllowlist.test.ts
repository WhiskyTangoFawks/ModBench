// Two folder-scoped exemptions from `no-unsafe-type-assertion`, the way BannedApiScopeTests pins
// RS0030's exemptions in the service: single-function helper modules, and the record document's
// traversal folder, which a helper can't reduce to one function.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const RULE = '@typescript-eslint/no-unsafe-type-assertion';

const HELPER_FILES = ['webview/src/columnKey.ts', 'webview/src/parseCompareResult.ts'];

const RECORD_DOCUMENT_TRAVERSAL_FILES = [
  'webview/src/recordUtils.ts', 'webview/src/presentation.ts', 'webview/src/siblingsInUse.ts',
  'webview/src/modelValue.ts',
];

interface RuleBlock {
  files: string[];
  severity: string;
}

function stringLiterals(node: ts.ArrayLiteralExpression): string[] {
  return node.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
}

// One config-array entry, `{ files: [...], rules: { ... } }`, that sets `RULE` — every shape
// this file's other blocks use it in.
function ruleBlocksFor(source: ts.SourceFile, rule: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const filesProp = node.properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'files',
      );
      const rulesProp = node.properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'rules',
      );
      if (filesProp && rulesProp && ts.isArrayLiteralExpression(filesProp.initializer)
        && ts.isObjectLiteralExpression(rulesProp.initializer)) {
        const ruleProp = rulesProp.initializer.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === rule,
        );
        if (ruleProp && ts.isStringLiteralLike(ruleProp.initializer)) {
          blocks.push({ files: stringLiterals(filesProp.initializer), severity: ruleProp.initializer.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return blocks;
}

function loadConfigBlocks(): RuleBlock[] {
  const path = join(__dirname, '..', '..', 'eslint.config.mjs');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
  return ruleBlocksFor(source, RULE);
}

function offBlocks(): RuleBlock[] {
  return loadConfigBlocks().filter((b) => b.severity === 'off');
}

describe('the no-unsafe-type-assertion allowlist', () => {
  it('is at error for production and test TypeScript alike, on both sides of the wire', () => {
    const errorBlock = loadConfigBlocks().find((b) => b.severity === 'error');

    expect(errorBlock?.files).toEqual(['src/**/*.ts', 'webview/src/**/*.{ts,tsx}']);
  });

  it('turns the rule off in exactly two places: helpers and the record document\'s traversal', () => {
    expect(offBlocks()).toHaveLength(2);
  });

  it('names exactly these two single-function modules as helpers, each its own file', () => {
    const helperBlock = offBlocks().find((b) => b.files.includes('webview/src/columnKey.ts'));

    expect(helperBlock?.files).toEqual(HELPER_FILES);
  });

  it('names exactly these four files as the record document\'s traversal, and no others', () => {
    const traversalBlock = offBlocks().find((b) => b.files.includes('webview/src/recordUtils.ts'));

    expect(traversalBlock?.files).toEqual(RECORD_DOCUMENT_TRAVERSAL_FILES);
  });
});
