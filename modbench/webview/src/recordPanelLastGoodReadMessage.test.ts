import { describe, it, expect } from 'vitest';
import { recordPanelLastGoodReadMessage } from './recordPanelLastGoodReadMessage';

const failure = (name: string, origin: string, reason: string) => ({ name, origin, reason });

describe('the message saying the panel shows the last good read', () => {
  it.each([
    ['says nothing while mEdit can read the record and every plugin the panel shows', null, [], [{ plugin: 'A.esp', origin: 'Data/' }], undefined],
    ['names the last good read, the plugin by filename and origin, and the reason for a shown plugin mEdit cannot read',
      null, [failure('A.esp', 'Data/', 'truncated')], [{ plugin: 'A.esp', origin: 'Data/' }], 'Showing the last good read: "A.esp" (Data/): truncated'],
    ['says nothing of a plugin the panel shows no column for',
      null, [failure('B.esp', 'Data/', 'truncated')], [{ plugin: 'A.esp', origin: 'Data/' }], undefined],
    ['tells two plugins of one filename apart by origin',
      null, [failure('Shared.esp', 'ModB', 'truncated')], [{ plugin: 'Shared.esp', origin: 'ModA' }], undefined],
    ['gives every shown plugin\'s reason',
      null, [failure('A.esp', 'Data/', 'one'), failure('B.esp', 'Data/', 'two')],
      [{ plugin: 'A.esp', origin: 'Data/' }, { plugin: 'B.esp', origin: 'Data/' }], 'Showing the last good read: "A.esp" (Data/): one; "B.esp" (Data/): two'],
    ['names the reason the panel\'s own read failed', 'mEdit is stopped.', [], [{ plugin: 'A.esp', origin: 'Data/' }],
      'Showing the last good read: mEdit is stopped.'],
    ['says it once when the panel\'s own read and a shown plugin\'s both failed',
      'mEdit is stopped', [failure('A.esp', 'Data/', 'truncated')], [{ plugin: 'A.esp', origin: 'Data/' }],
      'Showing the last good read: mEdit is stopped; "A.esp" (Data/): truncated'],
  ])('%s', (_case, readFailure, failures, shown, message) => {
    expect(recordPanelLastGoodReadMessage(readFailure, failures, shown)).toBe(message);
  });
});
