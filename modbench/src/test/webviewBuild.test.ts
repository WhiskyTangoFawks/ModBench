import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WEBVIEW_STYLESHEET } from '../drivingLib/webviewStylesheet';

describe('the webview build (npm run build)', () => {
  it('emits the stylesheet and the page scripts that the hosts link', () => {
    const emitted = readdirSync(join(__dirname, '../../out/webview/assets'));

    expect(emitted).toEqual(expect.arrayContaining([WEBVIEW_STYLESHEET, 'main.js', 'conflicts.js']));
  });
});
