import { describe, expect, it } from 'vitest';
import { WrittenFiles } from '../writtenFiles';

describe('the files a write wrote', () => {
  it('are each path named, once', () => {
    const written = new WrittenFiles();

    written.name(['/a', '/b']);
    written.name(['/a']);

    expect(written.named).toEqual(['/a', '/b']);
  });

  it('are none when none was named, which asks for no check of the disk', () => {
    expect(new WrittenFiles().named).toEqual([]);
  });

  it('are none named when a write left its files unnamed, though another named its own', () => {
    const written = new WrittenFiles();

    written.name(['/a']);
    written.leaveUnnamed();

    expect(written.named).toBeUndefined();
  });
});
