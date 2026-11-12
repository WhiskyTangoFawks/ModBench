/** The Command IDs a message names. The agent box holds each to a gesture it runs. */
export type GestureCommand =
  | 'modbench.modlist.gitInit' | 'modbench.mod.updateManifest' | 'modbench.mod.build' | 'modbench.mod.versionInGit' | 'modbench.plugin.decompile' | 'modbench.plugin.decompileAndRepair';

/** A gesture a message names: a view shows `view`, and an agent is given the tool that runs `command`. */
export interface GestureName { readonly command: GestureCommand; readonly view: string }

/** Words only a view reads, such as where in the screen to find a gesture. */
export interface ViewOnly { readonly viewOnly: string }

type Part = string | GestureName | ViewOnly;

/** A message whose gesture names stay data until an entry point renders them. A view reads `String(phrase)`. */
export class Phrase {
  constructor(readonly parts: readonly Part[]) {}

  toString(): string {
    return this.parts.map((part) => (typeof part === 'string' ? part : 'view' in part ? part.view : part.viewOnly)).join('');
  }
}

export type Message = string | Phrase;

export const gestureName = (command: GestureCommand, view: string): GestureName => ({ command, view });

export const viewOnly = (words: string): ViewOnly => ({ viewOnly: words });

type Piece = Part | Phrase;

export function phrase(strings: TemplateStringsArray, ...pieces: readonly Piece[]): Phrase {
  return new Phrase(strings.flatMap((text, index) => {
    const piece = pieces[index];
    return [text, ...piece === undefined ? [] : piece instanceof Phrase ? piece.parts : [piece]];
  }));
}

/** What an agent is given of a message: each gesture as `toolOf` names it, and nothing a view alone reads. */
export const forAgent = (message: Message, toolOf: (command: GestureCommand) => string): string =>
  (typeof message === 'string' ? message : message.parts.map((part) => (typeof part === 'string' ? part : 'view' in part ? toolOf(part.command) : '')).join(''));
