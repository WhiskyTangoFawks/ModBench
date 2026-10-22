import { describe, it, expect } from 'vitest';
import { nexusLogin } from '../nexusLogin';
import { acceptingGoodKey, GOOD_KEY, nexusAnswering } from '../../nexus/test/nexusDouble';

function loginOver() {
  const over = nexusAnswering(acceptingGoodKey);
  return { ...over, commands: nexusLogin(over.nexus) };
}

describe('logIn', () => {
  it('keeps a key Nexus accepts', async () => {
    const { commands, nexus } = loginOver();

    expect(await commands.logIn(GOOD_KEY)).toEqual({ applied: true, wrote: true });
    expect(await nexus.loggedIn()).toBe(true);
  });

  it('checks the key without the whitespace a paste leaves around it, and keeps it so', async () => {
    const { commands, sent, secrets } = loginOver();

    expect(await commands.logIn(` ${GOOD_KEY}\n`)).toMatchObject({ applied: true });
    expect(sent.map((s) => s.headers.get('apikey'))).toEqual([GOOD_KEY]);
    expect([...secrets.held.values()]).toEqual([GOOD_KEY]);
  });

  it('refuses a key Nexus refuses, keeping nothing', async () => {
    const { commands, nexus } = loginOver();

    expect(await commands.logIn('wrong')).toEqual({ applied: false, refusal: 'Nexus refused this key.' });
    expect(await nexus.loggedIn()).toBe(false);
  });

  it('refuses rather than throwing when the secret store cannot keep the key', async () => {
    const { commands, secrets } = loginOver();
    secrets.store = () => Promise.reject(new Error('keyring locked'));

    expect(await commands.logIn(GOOD_KEY)).toEqual({ applied: false, refusal: 'keyring locked' });
  });
});

describe('logOut', () => {
  it('forgets the key', async () => {
    const { commands, nexus } = loginOver();
    await commands.logIn(GOOD_KEY);

    expect(await commands.logOut()).toEqual({ applied: true, wrote: true });
    expect(await nexus.loggedIn()).toBe(false);
  });

  it('refuses rather than throwing when the secret store cannot forget the key', async () => {
    const { commands, secrets } = loginOver();
    secrets.delete = () => Promise.reject(new Error('keyring locked'));

    expect(await commands.logOut()).toEqual({ applied: false, refusal: 'keyring locked' });
  });
});
