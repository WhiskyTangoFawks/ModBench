const WORDS = {
  'modbench.modlist.gitInit': 'git init',
  'modbench.mod.updateManifest': 'update manifest',
  'modbench.mod.build': 'build',
  'modbench.mod.versionInGit': 'Version in Git',
  'modbench.plugin.decompile': 'Decompile Plugin',
} as const;

/** A gesture as a message names it, in curly quotes, for a user to read. An agent's reply names its tool in its place. */
export const gestureWord = (command: keyof typeof WORDS): string => `“${WORDS[command]}”`;

/** `text` with each gesture word `gestureWord` made replaced by what `named` gives its command. */
export const gestureWordsNamed = (text: string, named: (command: string) => string): string =>
  Object.entries(WORDS).reduce((result, [command, word]) => result.replaceAll(`“${word}”`, named(command)), text);
