import { gestureWordsNamed } from '../wire/gestureWords';

export const toolName = (command: string): string =>
  command.replace(/^modbench\./, '').replaceAll('.', '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** agent.md, Reporting, story 4: a reply names the tool that runs a gesture, where a view names the gesture. */
export const toolsNamed = (text: string): string => gestureWordsNamed(text, toolName);
