import { describe, it, expect } from 'vitest';
import { buildWebviewHtml } from '../webviewHtml';

const BASE_PARAMS = {
  formKey: 'Fallout4.esm:001234',
  port: 5172,
  scriptUri: 'vscode-webview://host/main.js',
  cspSource: 'vscode-webview-resource:',
};

describe('buildWebviewHtml', () => {
  it('includes a nonce in the CSP script-src', () => {
    const html = buildWebviewHtml(BASE_PARAMS);
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/]+=*'/);
  });

  it('applies the same nonce to the inline script tag', () => {
    const html = buildWebviewHtml(BASE_PARAMS);
    const nonceInCsp = html.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
    expect(nonceInCsp).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonceInCsp}">`);
  });

  it('sets mEditFormKey and mEditBackendPort in the inline script', () => {
    const html = buildWebviewHtml(BASE_PARAMS);
    expect(html).toContain('window.mEditFormKey = "Fallout4.esm:001234"');
    expect(html).toContain('window.mEditBackendPort = 5172');
  });

  it('uses unique nonces on each call', () => {
    const html1 = buildWebviewHtml(BASE_PARAMS);
    const html2 = buildWebviewHtml(BASE_PARAMS);
    const nonce1 = html1.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
    const nonce2 = html2.match(/'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
    expect(nonce1).not.toBe(nonce2);
  });
});
