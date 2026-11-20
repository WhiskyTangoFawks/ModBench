import { describe, it, expect } from 'vitest';
import { tellingOnSurface, type Told } from '../tellingOnSurface';
import { recordingReporter } from '../../test/surfacingDoubles';

const standing = (key: string, why: string): Told => ({ key, message: `${key} failed.`, why });
const told = (key: string, why: string) => ({ severity: 'error', message: `${key} failed.`, detail: why });
const notifying = (key: string, why: string): Told => ({ ...standing(key, why), notify: true });

describe('a failure the surface shows, told in the Output', () => {
  it.each([
    ['tells nothing when nothing stands', [[]], []],
    ['tells each standing failure', [[standing('A', 'truncated'), standing('B', 'bad header')]], [told('A', 'truncated'), told('B', 'bad header')]],
    ['tells a failure that stands on once', [[standing('A', 'truncated')], [standing('A', 'truncated')]], [told('A', 'truncated')]],
    ['tells a failure again when its reason changes', [[standing('A', 'truncated')], [standing('A', 'bad header')]],
      [told('A', 'truncated'), told('A', 'bad header')]],
    ['tells a failure again when it stands again after it cleared', [[standing('A', 'truncated')], [], [standing('A', 'truncated')]],
      [told('A', 'truncated'), told('A', 'truncated')]],
  ])('%s', (_case, rounds, lines) => {
    const reporter = recordingReporter();
    const tell = tellingOnSurface(reporter, 'error');

    rounds.forEach((round) => { tell(round); });

    expect(reporter.shownFailures).toEqual(lines);
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['notifies a line told as a notification, its one line in the Output', [[notifying('A', 'truncated')]], [told('A', 'truncated')], []],
    ['tells nothing more of a notified failure while it stands', [[notifying('A', 'truncated')], [standing('A', 'truncated')]], [told('A', 'truncated')], []],
    ['notifies a failure already told when its caller notifies it', [[standing('A', 'truncated')], [notifying('A', 'truncated')]],
      [told('A', 'truncated')], [told('A', 'truncated')]],
  ])('%s', (_case, rounds, notifications, lines) => {
    const reporter = recordingReporter();
    const tell = tellingOnSurface(reporter, 'error');

    rounds.forEach((round) => { tell(round); });

    expect(reporter.reports).toEqual(notifications);
    expect(reporter.shownFailures).toEqual(lines);
  });
});
