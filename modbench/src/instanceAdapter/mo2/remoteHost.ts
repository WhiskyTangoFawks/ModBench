// Where a source mod's remote is hosted, as a submodule's URL names it.

import type { SourceHost } from '../instanceAdapter';

const UNSAFE = 'its remote holds a credential that cannot safely be left out of its URL';

// instance-repository.md, The repository, story 3: a path or a file URL reaches no other machine.
const LOCAL = 'its remote is on this machine alone';

// git's scp-like form, [user@]host:path, whose host is longer than a Windows drive letter, and that form with a password.
const SCP_LIKE = /^([^/\\@:]+@)?[^/\\@:]{2,}:/;
const SCP_PASSWORD = /^[^/\\@:]{2,}:[^/\\]*@/;

// An HTTP user is a credential; another scheme's user names the account, so only its password goes.
const accountOf = (scheme: string, userInfo: string): string => {
  const [user = ''] = userInfo.split(':');
  return user === '' || /^https?$/i.test(scheme) ? '' : `${user}@`;
};

function scpLikeHost(url: string): SourceHost {
  if (SCP_PASSWORD.test(url)) return { kind: 'noHost', why: UNSAFE };
  return SCP_LIKE.test(url) ? { kind: 'host', url } : { kind: 'noHost', why: LOCAL };
}

export function hostOf(url: string): SourceHost {
  const [, scheme, authority = '', path = ''] = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(url) ?? [];
  if (scheme === undefined) return scpLikeHost(url);
  if (scheme.toLowerCase() === 'file') return { kind: 'noHost', why: LOCAL };
  const [userInfo = '', host, ...more] = authority.split('@');
  if (host === undefined) return { kind: 'host', url };
  return more.length > 0 || host === '' ? { kind: 'noHost', why: UNSAFE } : { kind: 'host', url: `${scheme}://${accountOf(scheme, userInfo)}${host}${path}` };
}
