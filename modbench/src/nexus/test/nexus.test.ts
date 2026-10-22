import { describe, it, expect } from 'vitest';
import { acceptingGoodKey, GOOD_KEY, nexusAnswering } from './nexusDouble';

describe('checking a key', () => {
  it('asks Nexus to validate it, naming the application and sending the key', async () => {
    const { nexus, sent } = nexusAnswering(acceptingGoodKey);

    await nexus.check(GOOD_KEY);

    const [request] = sent;
    expect(request?.url).toBe('https://api.nexusmods.com/v1/users/validate.json');
    expect(request?.headers.get('apikey')).toBe(GOOD_KEY);
    expect(request?.headers.get('Application-Name')).toBe('Modbench');
    expect(request?.headers.get('Application-Version')).toBe('1.2.3');
  });

  it('accepts a key Nexus accepts, and keeps nothing', async () => {
    const { nexus, secrets } = nexusAnswering(acceptingGoodKey);

    expect(await nexus.check(GOOD_KEY)).toEqual({ valid: true });
    expect(secrets.held.size).toBe(0);
  });

  it.each([
    ['refuses a key Nexus refuses', new Response('', { status: 401 }), 'Nexus refused this key.'],
    ['names the status when Nexus answers anything else', new Response('', { status: 503 }), 'Nexus answered 503.'],
    ['says why when Nexus cannot be reached', new Error('getaddrinfo ENOTFOUND'), 'Could not reach Nexus: getaddrinfo ENOTFOUND'],
  ])('%s', async (_name, answer, reason) => {
    const { nexus } = nexusAnswering(() => answer);

    expect(await nexus.check('k')).toEqual({ valid: false, reason });
  });
});

describe('keeping and forgetting a key', () => {
  it('is logged out until a key is kept, and logged out again once it is forgotten', async () => {
    const { nexus, secrets } = nexusAnswering(acceptingGoodKey);
    expect(await nexus.loggedIn()).toBe(false);

    await nexus.keep(GOOD_KEY);
    expect(await nexus.loggedIn()).toBe(true);
    expect([...secrets.held.values()]).toEqual([GOOD_KEY]);

    await nexus.forget();
    expect(await nexus.loggedIn()).toBe(false);
    expect(secrets.held.size).toBe(0);
  });

  it('tells a listener of each login change, and of no other secret', async () => {
    const { nexus, secrets } = nexusAnswering(acceptingGoodKey);
    let changes = 0;
    nexus.onDidChangeLogin(() => { changes++; });

    await nexus.keep(GOOD_KEY);
    await nexus.forget();
    await secrets.store('another.secret', 'x');

    expect(changes).toBe(2);
  });
});
