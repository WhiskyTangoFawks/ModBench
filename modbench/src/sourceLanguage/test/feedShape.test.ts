import { describe, expect, it } from 'vitest';
import { mergedFeeds } from '../feedShape';
import type { ProblemOnFile } from '../sourceProblems';

const at = { line: 0, character: 0 };
const problem = (message: string): ProblemOnFile => ({ message, start: at, end: at });

function published() {
  const sets: [string, readonly ProblemOnFile[]][] = [];
  const feedOf = mergedFeeds((file, problems) => sets.push([file, problems]));
  return { sets, links: feedOf('links'), paths: feedOf('paths') };
}

describe('the problems of several feeds, published together', () => {
  it('keeps the other feed\'s problems when one feed clears', () => {
    const { sets, links, paths } = published();
    links(new Map([['/a.json', [problem('link')]]]));
    paths(new Map([['/a.json', [problem('path')]], ['/b.json', [problem('other path')]]]));
    sets.length = 0;

    links(new Map());

    expect(sets).toEqual([['/a.json', [problem('path')]]]);
  });

  it('puts both feeds\' problems on one file', () => {
    const { sets, links, paths } = published();
    links(new Map([['/a.json', [problem('link')]]]));

    paths(new Map([['/a.json', [problem('path')]]]));

    expect(sets.at(-1)).toEqual(['/a.json', [problem('link'), problem('path')]]);
  });

  it('publishes only the files whose problems changed, and a file whose problems went with none', () => {
    const { sets, links } = published();
    links(new Map([['/a.json', [problem('one')]], ['/b.json', [problem('two')]]]));
    sets.length = 0;

    links(new Map([['/a.json', [problem('one')]], ['/c.json', [problem('three')]]]));

    expect(sets).toEqual([['/b.json', []], ['/c.json', [problem('three')]]]);
  });
});
