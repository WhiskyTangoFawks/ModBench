import { describe, it, expect } from 'vitest';
import { promptRefusal, refuseAgentName } from '../nameRefusals';
import { Refusal } from '../../drivingLib/refusal';

describe('a name refusal that could not be read', () => {
  it('shows a prompt why, rather than calling the name free', async () => {
    expect(await promptRefusal(Promise.reject(new Error('modlist.txt is locked')))).toBe('modlist.txt is locked');
    expect(await promptRefusal(Promise.resolve('taken'))).toBe('taken');
    expect(await promptRefusal(Promise.resolve(undefined))).toBeUndefined();
  });

  it('refuses an agent call with the refusal, or with why it could not be read', async () => {
    await expect(refuseAgentName(Promise.resolve('taken'))).rejects.toEqual(new Refusal('taken'));
    await expect(refuseAgentName(Promise.reject(new Error('modlist.txt is locked')))).rejects.toEqual(new Refusal('modlist.txt is locked'));
    await expect(refuseAgentName(Promise.resolve(undefined))).resolves.toBeUndefined();
  });
});
