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

  // #544: "Compare with winner" opening a freshly-created panel already scoped to a peer/winner
  // pair — the initial-page-load counterpart to LOAD_RECORD's own deltaScope field.
  it('defaults mEditDeltaScope to null when no scope is given', () => {
    const html = buildWebviewHtml(BASE_PARAMS);
    expect(html).toContain('window.mEditDeltaScope = null');
  });

  it('sets mEditDeltaScope to the given plugin + winner/peer origin pair', () => {
    const html = buildWebviewHtml({
      ...BASE_PARAMS, deltaScope: { plugin: 'Shared.esp', winnerOrigin: 'ModA', peerOrigin: 'ModB' },
    });
    expect(html).toContain('window.mEditDeltaScope = {"plugin":"Shared.esp","winnerOrigin":"ModA","peerOrigin":"ModB"}');
  });
});
