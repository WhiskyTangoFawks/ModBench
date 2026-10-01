import { describe, it, expect } from 'vitest';
import { recordPanelLoadFailureMessage } from './recordPanelLoadFailureMessage';

const failure = (name: string, origin: string, reason: string) => ({ name, origin, reason });

describe('recordPanelLoadFailureMessage', () => {
  it('says nothing while mEdit can read every plugin the panel shows', () => {
    expect(recordPanelLoadFailureMessage([], [{ plugin: 'A.esp', origin: 'Data' }])).toBeUndefined();
  });

  it('names the last good read, the plugin and the reason for a shown plugin mEdit cannot read', () => {
    expect(recordPanelLoadFailureMessage(
      [failure('A.esp', 'Data', 'truncated')], [{ plugin: 'A.esp', origin: 'Data' }],
    )).toBe('Showing the last good read: A.esp: truncated');
  });

  it('says nothing of a plugin the panel shows no column for', () => {
    expect(recordPanelLoadFailureMessage(
      [failure('B.esp', 'Data', 'truncated')], [{ plugin: 'A.esp', origin: 'Data' }],
    )).toBeUndefined();
  });

  it('tells two plugins of one filename apart by origin', () => {
    expect(recordPanelLoadFailureMessage(
      [failure('Shared.esp', 'ModB', 'truncated')], [{ plugin: 'Shared.esp', origin: 'ModA' }],
    )).toBeUndefined();
  });

  it('gives every shown plugin\'s reason', () => {
    expect(recordPanelLoadFailureMessage(
      [failure('A.esp', 'Data', 'one'), failure('B.esp', 'Data', 'two')],
      [{ plugin: 'A.esp', origin: 'Data' }, { plugin: 'B.esp', origin: 'Data' }],
    )).toBe('Showing the last good read: A.esp: one; B.esp: two');
  });
});
