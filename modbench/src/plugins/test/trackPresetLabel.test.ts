// The Edits preset's label names the plugin source root's real folder name. The Instance adapter
// hides layout.ts from every other box, so this reads text rather than importing it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../../ports/present';

const LAYOUT_FILE = join(__dirname, '..', '..', 'instanceAdapter', 'layout.ts');
const COMMANDS_FILE = join(__dirname, '..', 'pluginRowCommands.ts');

function pluginSourceFolderNameIn(text: string): string {
  return present(/PLUGIN_SOURCE_FOLDER = '([^']+)'/.exec(text)?.[1], "layout.ts's PLUGIN_SOURCE_FOLDER");
}

function editsLabelFolderNameIn(text: string): string {
  return present(
    /description: 'Keeps ([^/]+)\/ and \.gitignore'/.exec(text)?.[1],
    "pluginRowCommands.ts's Edits preset description",
  );
}

describe('the Track preset label', () => {
  it('names the same folder as the Instance adapter\'s layout', () => {
    const folderName = pluginSourceFolderNameIn(readFileSync(LAYOUT_FILE, 'utf8'));
    const labelledName = editsLabelFolderNameIn(readFileSync(COMMANDS_FILE, 'utf8'));

    expect(labelledName).toBe(folderName);
  });

  // Rival: a comparison that reports a match however the two files really read.
  it('catches a planted mismatch', () => {
    const layoutText = "export const PLUGIN_SOURCE_FOLDER = 'plugin-source';\n";
    const commandsText = "const EDITS_OPTION = { description: 'Keeps source/ and .gitignore' };\n";

    expect(editsLabelFolderNameIn(commandsText)).not.toBe(pluginSourceFolderNameIn(layoutText));
  });
});
