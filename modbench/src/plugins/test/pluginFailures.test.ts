import { describe, it, expect } from 'vitest';
import { tellFailedReads } from '../pluginFailures';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { PluginLoadFailure } from '../../client';

const failure = (name: string, origin: string, reason: string): PluginLoadFailure => ({ name, origin, reason });
const told = (name: string, origin: string, reason: string) =>
  ({ severity: 'error', message: `Failed to read "${name}" (${origin}).`, detail: reason });

describe('the Output line for each plugin whose read failed', () => {
  it.each([
    ['tells nothing when no read failed', [[]], []],
    ['tells each failed read once, naming its plugin by filename and origin, and the reason',
      [[failure('A.esp', 'ModA', 'truncated'), failure('A.esp', 'ModB', 'bad header')]],
      [told('A.esp', 'ModA', 'truncated'), told('A.esp', 'ModB', 'bad header')]],
    ['tells a failure that holds across reconciles once',
      [[failure('A.esp', 'ModA', 'truncated')], [failure('A.esp', 'ModA', 'truncated')]],
      [told('A.esp', 'ModA', 'truncated')]],
    ['tells a failure again when its reason changes',
      [[failure('A.esp', 'ModA', 'truncated')], [failure('A.esp', 'ModA', 'bad header')]],
      [told('A.esp', 'ModA', 'truncated'), told('A.esp', 'ModA', 'bad header')]],
    ['tells a failure again when it recurs after a good read',
      [[failure('A.esp', 'ModA', 'truncated')], [], [failure('A.esp', 'ModA', 'truncated')]],
      [told('A.esp', 'ModA', 'truncated'), told('A.esp', 'ModA', 'truncated')]],
  ])('%s', (_case, reconciles, lines) => {
    const reporter = recordingReporter();
    const tell = tellFailedReads(reporter);

    reconciles.forEach(tell);

    expect(reporter.shownFailures).toEqual(lines);
    expect(reporter.reports).toEqual([]);
  });
});
