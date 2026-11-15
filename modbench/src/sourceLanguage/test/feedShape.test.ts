import { describe, expect, it } from 'vitest';
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

  it('is settled when nothing was requested', async () => {
    expect(await idle(settling().settled())).toBe(true);
  });

  it('is unsettled from a request until the answer that took it ends', async () => {
    const feed = settling();
    feed.requested();
    let end: () => void = () => undefined;
    const answering = feed.answering(() => new Promise<void>((resolve) => { end = resolve; }));

    expect(await idle(feed.settled())).toBe(false);
    end();
    await answering;

    expect(await idle(feed.settled())).toBe(true);
  });

  it('stays unsettled for a request made while an answer runs', async () => {
    const feed = settling();
    feed.requested();
    let end: () => void = () => undefined;
    const answering = feed.answering(() => new Promise<void>((resolve) => { end = resolve; }));
    feed.requested();
    end();
    await answering;

    expect(await idle(feed.settled())).toBe(false);
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
