import { describe, it, expect } from 'vitest';
import { isPluginAddress, EXTENSION_TO_WEBVIEW, WEBVIEW_TO_EXTENSION, parseWebviewToExtension, parseExtensionToWebview } from '../messages';

describe('the messages that cross postMessage, checked by their type', () => {
  it.each(Object.values(WEBVIEW_TO_EXTENSION))('reaches the host as sent, a %s message', (type) => {
    const message = { type, payload: 'as sent' };
    expect(parseWebviewToExtension(message)).toBe(message);
  });

  it.each(Object.values(EXTENSION_TO_WEBVIEW))('reaches the webview as sent, a %s message', (type) => {
    const message = { type, payload: 'as sent' };
    expect(parseExtensionToWebview(message)).toBe(message);
  });

  it.each([null, 'editField', 7, { type: 'nonsense' }, {}])('is refused by both ends when it is %j', (message) => {
    expect(() => parseWebviewToExtension(message)).toThrow();
    expect(() => parseExtensionToWebview(message)).toThrow();
  });
});

describe('isPluginAddress', () => {
  it('holds a name and an origin, both strings', () => {
    expect(isPluginAddress({ name: 'A.esp', origin: 'Mod' })).toBe(true);
    expect(isPluginAddress({ name: 'A.esp' })).toBe(false);
    expect(isPluginAddress({ name: 'A.esp', origin: 1 })).toBe(false);
    expect(isPluginAddress(null)).toBe(false);
  });
});
