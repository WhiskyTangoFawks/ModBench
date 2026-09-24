import * as assert from 'assert';
import * as vscode from 'vscode';
import { before, describe, it } from 'mocha';
import type { ActivateExports } from '../../../extension';
import { IN_AN_INSTANCE, isRecord, requires } from '../../manifest';

// VS Code exposes neither a context key's value nor whether a welcome or a title-bar entry is
// showing, so this suite asserts the answer the extension wrote and the manifest VS Code loaded.

let ext: vscode.Extension<ActivateExports> | undefined;

interface Entry { command: string; when: string }

function contributed(packageJSON: unknown, pick: (contributes: Record<string, unknown>) => unknown, label: string): Entry[] {
  const entries = isRecord(packageJSON) && isRecord(packageJSON.contributes) ? pick(packageJSON.contributes) : undefined;
  if (!Array.isArray(entries)) throw new Error(`expected the loaded manifest to have ${label}`);
  return entries.map((e: unknown) => ({
    command: isRecord(e) && typeof e.command === 'string' ? e.command : '',
    when: isRecord(e) && typeof e.when === 'string' ? e.when : '',
  }));
}
const menu = (id: string) => (contributes: Record<string, unknown>) =>
  (isRecord(contributes.menus) ? contributes.menus[id] : undefined);

before(async () => {
  ext = vscode.extensions.all.find((e) => isRecord(e.packageJSON) && e.packageJSON.name === 'modbench');
  const deadline = Date.now() + 5000;
  while (ext && !ext.isActive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
});

describe('a folder that is not an instance', () => {
  it('activates, and answers the instance check: not an instance', () => {
    assert.ok(ext?.isActive, 'expected the extension to auto-activate via onStartupFinished');
    assert.strictEqual(ext.exports.folder, 'notAnInstance');
  });

  it('gives Mods, Plugins and Downloads no rows to show, so each shows its welcome', () => {
    assert.strictEqual(ext?.exports.modListProvider, undefined);
    assert.strictEqual(ext?.exports.pluginsTree, undefined);
    assert.strictEqual(ext?.exports.downloadsProvider, undefined);
    assert.strictEqual(ext?.exports.instance, undefined);
    assert.strictEqual(ext?.exports.instanceRead(), false);
  });

  it('offers no title-bar gesture: every entry VS Code loaded waits for an instance answer', () => {
    const entries = contributed(ext?.packageJSON, menu('view/title'), "a contributes.menus['view/title'] array");
    assert.ok(entries.length > 0, 'the loaded manifest has no title-bar entries — the shape changed');
    assert.deepStrictEqual(entries.filter((e) => !requires(e.when, IN_AN_INSTANCE)).map((e) => e.command), []);
  });

  // The palette lists every contributed command its `commandPalette` entry does not hide, so a
  // command this window never registered must be hidden there, and bound to no key, until an
  // instance answer.
  it('offers no palette entry or key for a command this window never registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const unregistered = contributed(ext?.packageJSON, (c) => c.commands, 'a contributes.commands array')
      .map((c) => c.command).filter((command) => !registered.has(command));
    assert.ok(unregistered.length > 0, 'every command is registered here — this suite is not outside an instance');
    const palette = contributed(ext?.packageJSON, menu('commandPalette'), "a contributes.menus['commandPalette'] array");
    const hidden = (command: string) =>
      palette.some((e) => e.command === command && (e.when === 'false' || requires(e.when, IN_AN_INSTANCE)));
    assert.deepStrictEqual(unregistered.filter((command) => !hidden(command)), [], 'offered in the palette');
    const keys = contributed(ext?.packageJSON, (c) => c.keybindings, 'a contributes.keybindings array');
    const boundUngated = keys.filter((k) => unregistered.includes(k.command) && !requires(k.when, IN_AN_INSTANCE));
    assert.deepStrictEqual(boundUngated.map((k) => k.command), [], 'bound to a key');
  });
});
