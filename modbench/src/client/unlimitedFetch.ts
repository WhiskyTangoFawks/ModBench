import { Agent, fetch as undiciFetch } from 'undici';

/** Undici's default Agent times out a fetch with no response after ~300s; blocking backend calls
 *  run for minutes, so 0 disables both. Own file: `undici` is Node-only. */
export function createUnlimitedFetch(): (input: Request) => Promise<Response> {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  // Handed a global `Request`, undici's own `fetch` coerces it to a URL string and fails, so it is
  // unpacked — `signal` included, or an abandoned reconcile's abort never reaches the network.
  return async (input) => {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    const body = hasBody ? await input.clone().arrayBuffer() : undefined;
    return undiciFetch(input.url, { method: input.method, headers: [...input.headers], body, dispatcher, signal: input.signal });
  };
}
