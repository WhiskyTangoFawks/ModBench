import { describe, it, expect } from 'vitest';
import { createNexus, type SecretStore } from '../nexus';

function memorySecrets(): SecretStore & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    get: (name) => Promise.resolve(held.get(name)),
    store: (name, value) => { held.set(name, value); return Promise.resolve(); },
    delete: (name) => { held.delete(name); return Promise.resolve(); },
  };
}

interface Sent { url: string; headers: Headers }

function nexusAnswering(answer: () => Response | Error) {
  const sent: Sent[] = [];
  const secrets = memorySecrets();
  const nexus = createNexus({
    secrets,
    applicationVersion: '1.2.3',
    fetch: (url, init) => {
      sent.push({ url, headers: new Headers(init.headers) });
      const result = answer();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  });
  return { nexus, sent, secrets };
}

const accepted = () => new Response('{"name":"someone"}', { status: 200 });

describe('checking a key', () => {
  it('asks Nexus to validate it, naming the application and sending the key', async () => {
    const { nexus, sent } = nexusAnswering(accepted);

    await nexus.check('the-key');

    const [request] = sent;
    expect(request?.url).toBe('https://api.nexusmods.com/v1/users/validate.json');
    expect(request?.headers.get('apikey')).toBe('the-key');
    expect(request?.headers.get('Application-Name')).toBe('Modbench');
    expect(request?.headers.get('Application-Version')).toBe('1.2.3');
  });

  it('accepts a key Nexus accepts', async () => {
    expect(await nexusAnswering(accepted).nexus.check('k')).toEqual({ valid: true });
  });

  it('refuses a key Nexus refuses, saying so', async () => {
    const { nexus } = nexusAnswering(() => new Response('', { status: 401 }));

    expect(await nexus.check('k')).toEqual({ valid: false, reason: 'Nexus refused this key.' });
  });

  it('refuses a key when Nexus answers anything else, naming the status', async () => {
    const { nexus } = nexusAnswering(() => new Response('', { status: 503 }));

    expect(await nexus.check('k')).toEqual({ valid: false, reason: 'Nexus answered 503.' });
  });

  it('refuses a key when Nexus cannot be reached, saying why', async () => {
    const { nexus } = nexusAnswering(() => new Error('getaddrinfo ENOTFOUND'));

    expect(await nexus.check('k')).toEqual({ valid: false, reason: 'Could not reach Nexus: getaddrinfo ENOTFOUND' });
  });

  it('keeps nothing', async () => {
    const { nexus, secrets } = nexusAnswering(accepted);

    await nexus.check('k');

    expect(secrets.held.size).toBe(0);
  });
});

describe('keeping and forgetting a key', () => {
  it('is logged out until a key is kept', async () => {
    expect(await nexusAnswering(accepted).nexus.loggedIn()).toBe(false);
  });

  it('is logged in once a key is kept, in the secret store', async () => {
    const { nexus, secrets } = nexusAnswering(accepted);

    await nexus.keep('the-key');

    expect(await nexus.loggedIn()).toBe(true);
    expect([...secrets.held.values()]).toEqual(['the-key']);
  });

  it('is logged out again once the key is forgotten, leaving nothing in the secret store', async () => {
    const { nexus, secrets } = nexusAnswering(accepted);
    await nexus.keep('the-key');

    await nexus.forget();

    expect(await nexus.loggedIn()).toBe(false);
    expect(secrets.held.size).toBe(0);
  });
});
