import { describe, expect, it } from 'vitest';
import { renameOutcome } from '../renameOutcome';

const RENAMED = { named: '"Mod A"', newName: 'Renamed', landed: 'Renamed', definition: 'its folder and lines' };

describe('a rename that carries every reference, as its gesture answers it (ADR-0028)', () => {
  it('lands what it renamed', () => {
    expect(renameOutcome({ applied: true, cannotFollow: [] }, RENAMED)).toEqual({ applied: true, outcome: { landed: ['Renamed'], refused: [] } });
  });

  it('lands with one warning naming each reference that could not follow (symbols.md, The features, story 7)', () => {
    expect(renameOutcome({ applied: true, cannotFollow: ['a', 'b'] }, RENAMED)).toEqual({
      applied: true,
      outcome: { landed: ['Renamed'], refused: [] },
      partial: [{ message: 'Renamed "Mod A" to "Renamed". 2 references to it could not follow.', detail: 'a\nb', severity: 'warning' }],
    });
  });

  it('says its refusal, with the detail it carries', () => {
    expect([
      renameOutcome({ applied: false, refusal: 'name taken' }, RENAMED),
      renameOutcome({ applied: false, refusal: 'could not check', detail: 'EACCES' }, RENAMED),
    ]).toEqual([{ applied: false, refusal: 'name taken', detail: undefined }, { applied: false, refusal: 'could not check', detail: 'EACCES' }]);
  });

  it('says its references and files may be partly changed when the edit did not apply, claiming no way back', () => {
    expect(renameOutcome({ applied: false, unapplied: 'EEXIST' }, RENAMED)).toEqual({
      applied: false, refusal: 'Could not rename "Mod A": its references may be partly changed, and its files and folders partly moved.', detail: 'EEXIST',
    });
  });

  it('says what the definition did not rename when a commit failed with nothing changed before it', () => {
    expect(renameOutcome({ applied: false, failed: 'locked', edited: false, moved: [] }, RENAMED)).toEqual({
      applied: false, refusal: 'Could not rename "Mod A": its folder and lines were not renamed.', detail: 'locked',
    });
  });

  it('names each file and folder that moved when a commit failed after the edit', () => {
    expect(renameOutcome({ applied: false, failed: 'locked', edited: true, moved: [{ from: '/source/Mod A', to: '/source/Renamed' }] }, RENAMED)).toEqual({
      applied: false,
      refusal: 'Could not rename "Mod A": its references were changed, and its folder and lines were not. /source/Mod A moved to /source/Renamed.',
      detail: 'locked',
    });
  });
});
