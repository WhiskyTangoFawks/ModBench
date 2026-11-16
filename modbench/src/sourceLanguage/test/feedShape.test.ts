import { describe, expect, it, vi } from 'vitest';
import { mergedFeeds, settling } from '../feedShape';
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

describe('a feed\'s settling', () => {
  const idle = async (settled: Promise<void>) => Promise.race([settled.then(() => true), Promise.resolve().then(() => false)]);

  it('is settled when nothing was asked', async () => {
    expect(await idle(settling().settled())).toBe(true);
  });

  const gated = () => {
    const ends: (() => void)[] = [];
    const body = () => new Promise<void>((resolve) => { ends.push(resolve); });
    return { body, ends };
  };

  it('is unsettled from a call until the run that takes it ends', async () => {
    const feed = settling();
    const { body, ends } = gated();
    feed.asking(body)();

    expect(await idle(feed.settled())).toBe(false);
    await vi.waitFor(() => { expect(ends).toHaveLength(1); });
    ends[0]?.();

    await feed.settled();
  });

  it('stays unsettled for a call made while a run goes, until the run after it ends', async () => {
    const feed = settling();
    const { body, ends } = gated();
    const ask = feed.asking(body);
    ask();
    await vi.waitFor(() => { expect(ends).toHaveLength(1); });
    ask();
    ends[0]?.();

    await vi.waitFor(() => { expect(ends).toHaveLength(2); });
    expect(await idle(feed.settled())).toBe(false);
    ends[1]?.();

    await feed.settled();
  });

  it('is unsettled while other work runs', async () => {
    const feed = settling();
    let end: () => void = () => undefined;
    const working = feed.working(() => new Promise<void>((resolve) => { end = resolve; }));

    expect(await idle(feed.settled())).toBe(false);
    end();
    await working;

    expect(await idle(feed.settled())).toBe(true);
  });
});
