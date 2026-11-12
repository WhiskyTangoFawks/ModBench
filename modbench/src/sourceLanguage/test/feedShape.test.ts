import { describe, expect, it } from 'vitest';
import { mergedFeeds } from '../feedShape';
import type { ProblemOnFile, ProblemsByFile } from '../sourceProblems';

const at = { line: 0, character: 0 };
const problem = (message: string): ProblemOnFile => ({ message, start: at, end: at });

describe('the problems of several feeds, published together', () => {
  it('keeps the other feed\'s problems when one feed clears', () => {
    const published: ProblemsByFile[] = [];
    const feeds = mergedFeeds((problems: ProblemsByFile) => published.push(problems), 'links', 'paths');
    feeds.links(new Map([['/a.json', [problem('link')]]]));
    feeds.paths(new Map([['/a.json', [problem('path')]], ['/b.json', [problem('other path')]]]));

    feeds.links(new Map());

    expect(published.at(-1)).toEqual(new Map([['/a.json', [problem('path')]], ['/b.json', [problem('other path')]]]));
  });

  it('puts both feeds\' problems on one file', () => {
    const published: ProblemsByFile[] = [];
    const feeds = mergedFeeds((problems: ProblemsByFile) => published.push(problems), 'links', 'paths');
    feeds.links(new Map([['/a.json', [problem('link')]]]));

    feeds.paths(new Map([['/a.json', [problem('path')]]]));

    expect(published.at(-1)).toEqual(new Map([['/a.json', [problem('link'), problem('path')]]]));
  });
});
