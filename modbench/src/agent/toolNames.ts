import { forAgent, type Message } from '../ports/phrase';

export const toolName = (command: string): string =>
  command.replace(/^modbench\./, '').replaceAll('.', '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export const toolNamed = (message: Message): string => forAgent(message, toolName);
