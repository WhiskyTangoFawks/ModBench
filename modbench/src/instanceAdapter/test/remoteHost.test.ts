import { describe, it, expect } from 'vitest';
import { hostOf } from '../remoteHost';

const UNSAFE = 'its remote holds a credential that cannot safely be left out of its URL';
const LOCAL = 'its remote is on this machine alone';

describe('a source mod\'s host, as its remote names it', () => {
  it.each([
    ['https://example.test/a.git', { kind: 'host', url: 'https://example.test/a.git' }],
    ['https://user:token@example.test/a.git', { kind: 'host', url: 'https://example.test/a.git' }],
    ['ssh://git:secret@example.test/a.git', { kind: 'host', url: 'ssh://git@example.test/a.git' }],
    ['git@example.test:owner/a.git', { kind: 'host', url: 'git@example.test:owner/a.git' }],
    ['https://user:p@ss@example.test/a.git', { kind: 'noHost', why: UNSAFE }],
    ['user:secret@example.test:a.git', { kind: 'noHost', why: UNSAFE }],
    ['../a', { kind: 'noHost', why: LOCAL }],
    ['C:\\srv\\a.git', { kind: 'noHost', why: LOCAL }],
    ['file:///srv/a.git', { kind: 'noHost', why: LOCAL }],
  ])('reads the remote %s as %j', (remote, host) => {
    expect(hostOf(remote)).toEqual(host);
  });
});
