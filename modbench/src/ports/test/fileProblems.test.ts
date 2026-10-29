import { describe, it, expect } from 'vitest';
import { fileProblemsOver, type ProblemsHost } from '../fileProblems';

function recordingHost() {
  const published = new Map<string, string[]>();
  const host: ProblemsHost<string> = {
    diagnostic: ({ line, message }) => `${line}:${message}`,
    publish: (file, diagnostics) => { published.set(file, [...diagnostics]); },
    clearAll: () => { published.clear(); },
  };
  return { host, published };
}

describe('a file\'s problems in the Problems panel and the Output', () => {
  it('publishes each problem on its file and writes a line in the Output for each', () => {
    const { host, published } = recordingHost();
    const lines: string[] = [];

    fileProblemsOver(host, { info: () => {}, error: () => {}, warn: (line) => lines.push(line) })
      .set('/instance/ModOrganizer.ini', [{ line: 4, message: 'first' }, { line: 9, message: 'second' }]);

    expect([published.get('/instance/ModOrganizer.ini'), lines]).toEqual([
      ['4:first', '9:second'], ['/instance/ModOrganizer.ini:4: first', '/instance/ModOrganizer.ini:9: second'],
    ]);
  });

  it('clears the problems of a file set to none, writing nothing to the Output', () => {
    const { host, published } = recordingHost();
    const lines: string[] = [];
    const problems = fileProblemsOver(host, { info: () => {}, error: () => {}, warn: (line) => lines.push(line) });
    problems.set('/a', [{ line: 1, message: 'x' }]);
    lines.length = 0;

    problems.set('/a', []);

    expect([published.get('/a'), lines]).toEqual([[], []]);
  });

  it('clears every file', () => {
    const { host, published } = recordingHost();
    const problems = fileProblemsOver(host, { info: () => {}, error: () => {}, warn: () => {} });
    problems.set('/a', [{ line: 1, message: 'x' }]);

    problems.clearAll();

    expect(published.size).toBe(0);
  });
});
