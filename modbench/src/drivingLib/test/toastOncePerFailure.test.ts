import { describe, it, expect } from 'vitest';
import { toastOncePerFailure } from '../toastOncePerFailure';
import { recordingReporter } from '../../test/surfacingDoubles';

describe('a source that throws, toasted once per failure', () => {
  const source = {};

  it('toasts a source\'s repeated throw once and still writes each repeat to the Output', () => {
    const reporter = recordingReporter();
    const throws = toastOncePerFailure(reporter);

    throws.threw(source, 'stale', 'boom');
    throws.threw(source, 'stale', 'boom');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'stale', detail: 'boom' }]);
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'stale', detail: 'boom' }]);
  });

  it('toasts a throw again once the source has recovered', () => {
    const reporter = recordingReporter();
    const throws = toastOncePerFailure(reporter);

    throws.threw(source, 'stale', 'boom');
    throws.recovered(source);
    throws.threw(source, 'stale', 'boom');

    expect(reporter.reports).toHaveLength(2);
  });

  it('toasts a different reason, and a different source, on its own', () => {
    const reporter = recordingReporter();
    const throws = toastOncePerFailure(reporter);

    throws.threw(source, 'stale', 'boom');
    throws.threw(source, 'stale', 'bang');
    throws.threw({}, 'stale', 'bang');

    expect(reporter.reports.map((r) => r.detail)).toEqual(['boom', 'bang', 'bang']);
  });
});
