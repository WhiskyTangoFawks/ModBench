import { describe, it, expect } from 'vitest';
import { recordPanelLoadFailureMessage } from './recordPanelLoadFailureMessage';

const failure = (name: string, origin: string, reason: string) => ({ name, origin, reason });

describe('the message naming the plugins mEdit cannot read', () => {
  it.each([
    ['says nothing while mEdit can read every plugin the panel shows', [], [{ plugin: 'A.esp', origin: 'Data/' }], undefined],
    ['names the last good read, the plugin and the reason for a shown plugin mEdit cannot read',
      [failure('A.esp', 'Data/', 'truncated')], [{ plugin: 'A.esp', origin: 'Data/' }], 'Showing the last good read: A.esp: truncated'],
    ['says nothing of a plugin the panel shows no column for',
      [failure('B.esp', 'Data/', 'truncated')], [{ plugin: 'A.esp', origin: 'Data/' }], undefined],
    ['tells two plugins of one filename apart by origin',
      [failure('Shared.esp', 'ModB', 'truncated')], [{ plugin: 'Shared.esp', origin: 'ModA' }], undefined],
    ['gives every shown plugin\'s reason',
      [failure('A.esp', 'Data/', 'one'), failure('B.esp', 'Data/', 'two')],
      [{ plugin: 'A.esp', origin: 'Data/' }, { plugin: 'B.esp', origin: 'Data/' }], 'Showing the last good read: A.esp: one; B.esp: two'],
  ])('%s', (_case, failures, shown, message) => {
    expect(recordPanelLoadFailureMessage(failures, shown)).toBe(message);
  });
});
