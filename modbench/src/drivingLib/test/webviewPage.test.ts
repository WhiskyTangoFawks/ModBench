import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { path: string }) => parts.path,
    joinPath: (base: string, ...parts: string[]) => [base, ...parts].join('/'),
  },
}));

import * as vscode from 'vscode';
import { WEBVIEW_SCRIPTS } from '../../wire/webviewPages';
import { showWebviewPage, type WebviewPage } from '../webviewPage';

const RECORD_PAGE: WebviewPage = { script: WEBVIEW_SCRIPTS.RECORD_PANEL };

function shown(page: WebviewPage) {
  const webview = {
    html: '', options: {}, cspSource: 'vscode-webview-resource:', asWebviewUri: (uri: vscode.Uri) => uri,
  };
  showWebviewPage(webview, vscode.Uri.from({ scheme: 'file', path: 'ext' }), page);
  return webview;
}

const nonceOf = (html: string): string | undefined => /'nonce-([A-Za-z0-9+/]+=*)'/.exec(html)?.[1];

describe('a page of the webview build, loaded into a webview', () => {
  it('runs scripts from the build\'s own folder alone', () => {
    expect(shown(RECORD_PAGE).options).toEqual({ enableScripts: true, localResourceRoots: ['ext/out/webview'] });
  });

  it('reaches the images folder a page names, and no page that names none', () => {
    const withImages = shown({ ...RECORD_PAGE, imagesFolder: 'staging/release' as unknown as vscode.Uri });
    expect(withImages.options).toEqual({ enableScripts: true, localResourceRoots: ['ext/out/webview', 'staging/release'] });
    expect(withImages.html).toContain('img-src vscode-webview-resource:;');

    expect(shown(RECORD_PAGE).html).not.toContain('img-src');
  });

  it('loads the page\'s own script and stylesheet', () => {
    const { html } = shown(RECORD_PAGE);
    expect(html).toContain('<script type="module" src="ext/out/webview/assets/main.js">');
    expect(html).toContain('<link rel="stylesheet" href="ext/out/webview/assets/webview.css">');
  });

  it('links the build\'s one stylesheet on every page', () => {
    expect(shown({ script: WEBVIEW_SCRIPTS.CONFLICT_TABLE }).html).toContain('<link rel="stylesheet" href="ext/out/webview/assets/webview.css">');
  });

  it('includes a nonce in the CSP script-src, and applies it to the inline script tag', () => {
    const { html } = shown(RECORD_PAGE);
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/]+=*'/);
    expect(html).toContain(`<script nonce="${nonceOf(html) ?? 'no nonce'}">`);
  });

  it('sets each global on the window before the page\'s script runs', () => {
    const { html } = shown({ ...RECORD_PAGE, globals: { mEditFormKey: 'Fallout4.esm:001234' } });
    expect(html).toContain('window.mEditFormKey = "Fallout4.esm:001234";');
    expect(html.indexOf('window.mEditFormKey')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('writes a value holding markup so that the inline script parses back to the value', () => {
    const hostile = 'C:/mods/<!--<script>x</script>"\\\'';
    const { html } = shown({ ...RECORD_PAGE, globals: { mEditLoadError: hostile } });
    const inline = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(inline).not.toContain('<');
    expect(JSON.parse(inline.replace(/^window\.mEditLoadError = /, '').replace(/;$/, ''))).toBe(hostile);
  });

  it('loads its fonts from its own resources alone', () => {
    expect(shown(RECORD_PAGE).html).toMatch(/font-src vscode-webview-resource:;/);
  });

  it('uses unique nonces on each load', () => {
    expect(nonceOf(shown(RECORD_PAGE).html)).not.toBe(nonceOf(shown(RECORD_PAGE).html));
  });
});
