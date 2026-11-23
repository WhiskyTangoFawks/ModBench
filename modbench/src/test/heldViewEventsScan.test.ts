import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { productionFiles, SRC } from './scanSource';

const VIEW_EVENT = /readonly onDidChange(?:TreeData|FileDecorations) = this\.(\w+)\.event/g;

const unheldIn = (source: string): string[] => [...source.matchAll(VIEW_EVENT)].flatMap(([, emitter = '']) =>
  (new RegExp(`\\b${emitter} = new vscode\\.EventEmitter\\b`).test(source) ? [emitter] : []));

describe('every view\'s tree and decorations are ones a gesture writing from it holds (common.md, A gesture that writes, story 1)', () => {
  it('no view fires its tree or decorations from an emitter a gesture does not hold', () => {
    const offenders = Object.fromEntries(productionFiles(SRC).flatMap((path) => {
      const unheld = unheldIn(readFileSync(path, 'utf8'));
      return unheld.length === 0 ? [] : [[relative(SRC, path), unheld]];
    }));

    expect(offenders).toEqual({});
  });

  it('flags a view that fires from a bare emitter, and leaves a held one alone', () => {
    expect([
      unheldIn('private readonly changed = new vscode.EventEmitter<undefined>();\n  readonly onDidChangeTreeData = this.changed.event;'),
      unheldIn('private readonly changed = new RedrawEmitter<undefined>(VIEW);\n  readonly onDidChangeTreeData = this.changed.event;'),
    ]).toEqual([['changed'], []]);
  });
});
