import { describe, it, expect } from 'vitest';
import { isPluginAddress, parseWebviewToExtension, parseExtensionToWebview } from '../messages';

describe('the messages that cross postMessage, checked by their type', () => {
  it.each([
    ['host', parseWebviewToExtension, 'editField'],
    ['webview', parseExtensionToWebview, 'loadRecord'],
  ] as const)('reaches the %s as sent, a message of a type it takes', (_end, parse, type) => {
    const message = { type, payload: 'as sent' };
    expect(parse(message)).toBe(message);
  });

  it.each([null, 'editField', 7, { type: 'nonsense' }, {}])('is refused by both ends when it is %j', (message) => {
    expect(() => parseWebviewToExtension(message)).toThrow();
    expect(() => parseExtensionToWebview(message)).toThrow();
  });
});

describe('isPluginAddress', () => {
  it.each([
    [true, 'a name and an origin, both strings', { name: 'A.esp', origin: 'Mod' }],
    [false, 'a name with no origin', { name: 'A.esp' }],
    [false, 'an origin that is not a string', { name: 'A.esp', origin: 1 }],
    [false, 'null', null],
  ])('is %s given %s', (isAddress, _, value) => {
    expect(isPluginAddress(value)).toBe(isAddress);
  });
});
