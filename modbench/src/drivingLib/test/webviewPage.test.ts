import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { path: string }) => parts.path,
    joinPath: (base: string, ...parts: string[]) => [base, ...parts].join('/'),
  },
}));

import * as vscode from 'vscode';
import { showWebviewPage } from '../webviewPage';

function shown(page: string, globals?: Record<string, unknown>) {
  const webview = {
    html: '', options: {}, cspSource: 'vscode-webview-resource:', asWebviewUri: (uri: vscode.Uri) => uri,
  };
  showWebviewPage(webview, vscode.Uri.from({ scheme: 'file', path: 'ext' }), page, globals);
  return webview;
}

const nonceOf = (html: string): string | undefined => /'nonce-([A-Za-z0-9+/]+=*)'/.exec(html)?.[1];

describe('a page of the webview build, loaded into a webview', () => {
  it('runs scripts from the build\'s own folder alone', () => {
    expect(shown('main').options).toEqual({ enableScripts: true, localResourceRoots: ['ext/out/webview'] });
  });

  it('loads the page\'s own script and stylesheet', () => {
    const { html } = shown('conflicts');
    expect(html).toContain('<script type="module" src="ext/out/webview/assets/conflicts.js">');
    expect(html).toContain('<link rel="stylesheet" href="ext/out/webview/assets/conflicts.css">');
  });

  it('includes a nonce in the CSP script-src, and applies it to the inline script tag', () => {
    const { html } = shown('main');
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/]+=*'/);
    expect(html).toContain(`<script nonce="${nonceOf(html) ?? 'no nonce'}">`);
  });

  it('sets each global on the window before the page\'s script runs', () => {
    const { html } = shown('main', { mEditFormKey: 'Fallout4.esm:001234' });
    expect(html).toContain('window.mEditFormKey = "Fallout4.esm:001234";');
    expect(html.indexOf('window.mEditFormKey')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('loads its fonts from its own resources alone', () => {
    expect(shown('main').html).toMatch(/font-src vscode-webview-resource:;/);
  });

  it('uses unique nonces on each load', () => {
    expect(nonceOf(shown('main').html)).not.toBe(nonceOf(shown('main').html));
  });

  it('names no backend port, and no connect-src to localhost, since the webview reads through its host', () => {
    const { html } = shown('main');
    expect(html).not.toContain('mEditBackendPort');
    expect(html).not.toMatch(/connect-src[^;]*localhost/);
  });
});
