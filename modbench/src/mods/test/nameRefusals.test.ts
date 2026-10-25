import { describe, it, expect } from 'vitest';
import { promptRefusal, refuseAgentName } from '../nameRefusals';
import { Refusal } from '../../drivingLib/refusal';

describe('a name refusal that could not be read', () => {
  it.each<[string, () => Promise<string | undefined>, string | undefined]>([
    ['shows why it could not be read, rather than calling the name free', () => Promise.reject(new Error('modlist.txt is locked')), 'modlist.txt is locked'],
    ['shows the refusal read', () => Promise.resolve('taken'), 'taken'],
    ['shows nothing for a free name', () => Promise.resolve(undefined), undefined],
  ])('a prompt %s', async (_case, refusal, expected) => {
    expect(await promptRefusal(refusal())).toBe(expected);
  });

  it.each<[string, () => Promise<string | undefined>, Refusal | undefined]>([
    ['is refused with the refusal read', () => Promise.resolve('taken'), new Refusal('taken')],
    ['is refused with why the refusal could not be read', () => Promise.reject(new Error('modlist.txt is locked')), new Refusal('modlist.txt is locked')],
    ['goes on for a free name', () => Promise.resolve(undefined), undefined],
  ])('an agent call %s', async (_case, refusal, expected) => {
    expect(await refuseAgentName(refusal()).then(() => undefined, (error: unknown) => error)).toEqual(expected);
  });
});
