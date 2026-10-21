import { describe, it, expect } from 'vitest';
import { reportSubscriberThrows } from '../reportSubscriberThrows';
import { toastOncePerFailure } from '../toastOncePerFailure';
import { recordingReporter } from '../../test/surfacingDoubles';
import { Instance } from '../../instanceLoader/instance';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { GAME_FOLDER_SETTING_ID } from '../../test/gameFolderSetting';
import { STEADY_WINDOW } from '../../test/steadyWindow';

function wired() {
  const fake = fakeInstanceAdapter(readingFixture());
  const instance = new Instance({
    adapter: fake.adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, window: STEADY_WINDOW,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const reporter = recordingReporter();
  reportSubscriberThrows(instance, toastOncePerFailure(reporter));
  return { instance, fake, reporter };
}

describe('reportSubscriberThrows', () => {
  it('toasts once, and writes every throw to the Output, for a subscriber that throws on every read', async () => {
    const { instance, reporter } = wired();
    instance.subscribe(() => { throw new Error('subscriber exploded'); });

    await instance.refresh();
    await instance.refresh();
    instance.dispose();

    expect(reporter.reports.map((r) => r.detail)).toEqual(['subscriber exploded']);
    expect(reporter.shownFailures.map((r) => r.detail)).toEqual(['subscriber exploded']);
  });

  it('toasts again when a subscriber throws after a read it took', async () => {
    const { instance, reporter } = wired();
    let throwing = true;
    instance.subscribe(() => { if (throwing) throw new Error('subscriber exploded'); });

    await instance.refresh();
    throwing = false;
    await instance.refresh();
    throwing = true;
    await instance.refresh();
    instance.dispose();

    expect(reporter.reports).toHaveLength(2);
  });

  it('words a read-failure listener\'s throw as following a failed read', async () => {
    const { instance, fake, reporter } = wired();
    instance.onReadFailure(() => { throw new Error('failure listener exploded'); });
    fake.failReading('unreadable');

    await instance.refresh();
    instance.dispose();

    expect(reporter.reports.map((r) => r.message).join()).toContain('failed read');
  });
});
