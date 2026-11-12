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
  const parts = strings.flatMap((text, index) => {
    const piece = pieces[index];
    return [text, ...piece === undefined ? [] : piece instanceof Phrase ? piece.parts : [piece]];
  });
  return new Phrase(parts.reduce<Part[]>((merged, part) => {
    const last = merged.at(-1);
    if (typeof part === 'string' && typeof last === 'string') merged[merged.length - 1] = last + part;
    else merged.push(part);
    return merged;
  }, []));
}

/** A reason mEdit stated as fact, with the remedy the command that owns the gesture words for the kind mEdit named (ADR-0016). */
export const withRemedy = <Item, Kind extends string>(remedies: Partial<Record<Kind, (item: Item) => Phrase>>) =>
  ({ item, reason, refusal }: { item: Item; reason: string; refusal?: Kind }): { item: Item; reason: Message } => {
    const remedy = refusal === undefined ? undefined : remedies[refusal];
    return { item, reason: remedy === undefined ? reason : phrase`${reason} ${remedy(item)}` };
  };

/** What an agent is given of a message: each gesture as `toolOf` names it, and nothing a view alone reads. */
export const forAgent = (message: Message, toolOf: (command: GestureCommand) => string): string =>
  (typeof message === 'string' ? message : message.parts.map((part) => (typeof part === 'string' ? part : 'view' in part ? toolOf(part.command) : '')).join(''));
