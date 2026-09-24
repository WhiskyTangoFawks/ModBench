// Every list lets the user select several rows (common.md, A view, story 6). The Toolbox is a
// readout, not a list, and selecting several of its rows means nothing (toolbox.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsFiles } from './tsFiles';
import { isRecord } from './manifest';
import { present } from '../ports/present';

const SINGLE_SELECT_VIEWS = ['modbench.toolbox'];

interface TreeRegistration { id: string; selectsMany: boolean }

function treeRegistrationsIn(source: string): TreeRegistration[] {
  return [...source.matchAll(/createTreeView\(\s*'([^']+)'\s*,\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => ({
    id: present(m[1], 'the matched view id'),
    selectsMany: /\bcanSelectMany:\s*true\b/.test(present(m[2], 'the matched options object')),
  }));
}

const productionRegistrations = (): TreeRegistration[] =>
  tsFiles(join(__dirname, '..'), { includeTests: false, exclude: ['test'] })
    .flatMap((path) => treeRegistrationsIn(readFileSync(path, 'utf8')));

function declaredViewIds(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  if (!isRecord(manifest) || !isRecord(manifest.contributes) || !isRecord(manifest.contributes.views)) {
    throw new Error('Expected package.json to have a contributes.views object.');
  }
  return Object.values(manifest.contributes.views).flatMap((views: unknown) =>
    (Array.isArray(views) ? views : []).map((view: unknown) => (isRecord(view) ? String(view.id) : '')));
}

describe('every list tree selects several rows', () => {
  it('finds a registration for every view the manifest declares', () => {
    expect(productionRegistrations().map((r) => r.id).sort()).toEqual(declaredViewIds().sort());
  });

  it('every registration but the Toolbox enables multi-select', () => {
    const singleSelect = productionRegistrations()
      .filter((r) => !r.selectsMany && !SINGLE_SELECT_VIEWS.includes(r.id))
      .map((r) => r.id);
    expect(singleSelect).toEqual([]);
  });

  it('reads a registration with the option off, or absent, as single-select', () => {
    expect(treeRegistrationsIn(`
      vscode.window.createTreeView('a', { treeDataProvider: p, canSelectMany: true, showCollapseAll: true });
      vscode.window.createTreeView('b', { treeDataProvider: p, canSelectMany: false });
      vscode.window.createTreeView('c', {
        treeDataProvider: p,
        dragAndDropController: p,
      });
    `)).toEqual([
      { id: 'a', selectsMany: true },
      { id: 'b', selectsMany: false },
      { id: 'c', selectsMany: false },
    ]);
  });
});
