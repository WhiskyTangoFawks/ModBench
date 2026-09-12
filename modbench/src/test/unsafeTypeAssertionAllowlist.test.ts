// The record-document allowlist is the one folder-scoped exemption from
// `no-unsafe-type-assertion`, the way BannedApiScopeTests pins RS0030's exemptions in the service.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const RULE = '@typescript-eslint/no-unsafe-type-assertion';

const RECORD_DOCUMENT_ALLOWLIST = [
  'webview/src/recordUtils.ts', 'webview/src/presentation.ts', 'webview/src/siblingsInUse.ts',
  'webview/src/modelValue.ts', 'webview/src/types.ts', 'webview/src/RecordPanelClient.ts',
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

// A test glob names a `.test.` file or a `test/` folder — the other place this rule turns off,
// out of scope here (it shrinks to nothing on its own ticket).
function isTestGlob(files: string[]): boolean {
  return files.some((f) => f.includes('.test.') || f.includes('/test/'));
}

describe('the no-unsafe-type-assertion allowlist', () => {
  it('is at error for production TypeScript, on both sides of the wire', () => {
    const errorBlock = loadConfigBlocks().find((b) => b.severity === 'error');

    expect(errorBlock?.files).toEqual(['src/**/*.ts', 'webview/src/**/*.{ts,tsx}']);
  });

  it('turns the rule off in exactly two places: the record document, and tests', () => {
    const offBlocks = loadConfigBlocks().filter((b) => b.severity === 'off');

    expect(offBlocks).toHaveLength(2);
  });

  it('names exactly these six files as the record document, and no others', () => {
    const offBlocks = loadConfigBlocks().filter((b) => b.severity === 'off');
    const allowlistBlock = offBlocks.find((b) => !isTestGlob(b.files));

    expect(allowlistBlock?.files).toEqual(RECORD_DOCUMENT_ALLOWLIST);
  });
});
