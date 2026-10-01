import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  creationClubListFile, dataFolderFile, gameMastersOf, gameReleaseForGame, nexusSlugFor, gamePathInfoForRelease,
} from '../gamePaths';

describe('gameReleaseForGame', () => {
  it('maps a game\'s name, as an instance\'s settings spell it, to Mutagen\'s release name', () => {
    // Each mapping is independent real data, so each earns its own assertion.
    expect(gameReleaseForGame('Fallout 4')).toBe('Fallout4');
    expect(gameReleaseForGame('Fallout 4 VR')).toBe('Fallout4VR');
    expect(gameReleaseForGame('Fallout 3')).toBe('Fallout3');
    expect(gameReleaseForGame('Fallout New Vegas')).toBe('FalloutNV');
    expect(gameReleaseForGame('Skyrim Special Edition')).toBe('SkyrimSE');
    expect(gameReleaseForGame('Skyrim VR')).toBe('SkyrimVR');
    expect(gameReleaseForGame('Enderal')).toBe('EnderalLE');
    expect(gameReleaseForGame('Oblivion')).toBe('Oblivion');
  });

  // The one name whose two vocabularies disagree beyond spacing: MO2 says "Skyrim" for what
  // Mutagen calls the Legendary Edition, so a whitespace strip would answer a release that
  // does not exist.
  it('maps MO2\'s bare "Skyrim" to the Legendary Edition, not to "Skyrim"', () => {
    expect(gameReleaseForGame('Skyrim')).toBe('SkyrimLE');
  });

  // Every value has to be a name the backend's Enum.TryParse<GameRelease> accepts, so a game
  // Mutagen has no release for gets no entry rather than a plausible-looking one.
  it('answers undefined for a game Mutagen has no release for', () => {
    expect(gameReleaseForGame('Morrowind')).toBeUndefined();
  });

  it('answers undefined for an unknown game rather than guessing one', () => {
    expect(gameReleaseForGame('Some Game')).toBeUndefined();
    expect(gameReleaseForGame('')).toBeUndefined();
  });
});

describe('nexusSlugFor', () => {
  it('maps a release to its Nexus slug', () => {
    expect(nexusSlugFor('Fallout4', 'Fallout 4')).toBe('fallout4');
    expect(nexusSlugFor('SkyrimSE', 'Skyrim Special Edition')).toBe('skyrimspecialedition');
    // Each mapping is independent real data, so each earns its own assertion.
    expect(nexusSlugFor('Fallout3', 'Fallout 3')).toBe('fallout3');
    expect(nexusSlugFor('FalloutNV', 'Fallout New Vegas')).toBe('newvegas');
    expect(nexusSlugFor('SkyrimLE', 'Skyrim')).toBe('skyrim');
    expect(nexusSlugFor('EnderalLE', 'Enderal')).toBe('enderal');
    expect(nexusSlugFor('Oblivion', 'Oblivion')).toBe('oblivion');
  });

  it('maps VR variants to their non-VR Nexus domain', () => {
    expect(nexusSlugFor('Fallout4VR', 'Fallout 4 VR')).toBe('fallout4');
    expect(nexusSlugFor('SkyrimVR', 'Skyrim VR')).toBe('skyrimspecialedition');
  });

  // Rival: keying on the name as the instance's settings spell it, beside the release answered.
  it('keys on the release, not the name', () => {
    expect(nexusSlugFor('SkyrimSE', 'Fallout 4')).toBe('skyrimspecialedition');
  });

  // Morrowind has no release, so this exercises the fallback path rather than a table row — the
  // fallback happens to match Nexus's own slug.
  it('falls back to a lowercased, space-stripped name for a game with no release', () => {
    expect(nexusSlugFor(undefined, 'Morrowind')).toBe('morrowind');
    expect(nexusSlugFor(undefined, 'Some Game')).toBe('somegame');
  });
});

describe('gamePathInfoForRelease', () => {
  it('answers Fallout 4\'s Steam install facts', () => {
    expect(gamePathInfoForRelease('Fallout4')).toMatchObject({
      gameName: 'Fallout 4',
      nexusSlug: 'fallout4',
      steamAppId: '377160',
      steamFolderName: 'Fallout 4',
    });
  });

  // A release the table only knows the Nexus slug for carries no Steam facts — the
  // autodetector's signal to give up rather than guess a folder.
  it('answers no Steam facts for a release the table cannot autodetect', () => {
    const info = gamePathInfoForRelease('SkyrimSE');
    expect(info).toMatchObject({ gameName: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition' });
    expect(info?.steamAppId).toBeUndefined();
    expect(info?.steamFolderName).toBeUndefined();
  });

  it('answers undefined for a release the table holds no row for', () => {
    expect(gamePathInfoForRelease('SomeRelease')).toBeUndefined();
  });
});

describe('dataFolderFile', () => {
  it('names a file at the root of the Data folder of a game folder found', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe('/game/Data/Fallout4.esm');
  });

  it('names the same file when the Data folder setting ends in a separator', () => {
    const found = { kind: 'found', root: '/game', dataFolder: '/game/Data/' } as const;
    expect(dataFolderFile(found, 'Fallout4.esm')).toBe('/game/Data/Fallout4.esm');
  });

  it('names nothing while the game folder is not found', () => {
    const notFound = { kind: 'notFound', looked: [], setting: 'modbench.mods.gameDirectory' } as const;
    expect(dataFolderFile(notFound, 'Fallout4.esm')).toBeUndefined();
  });
});

// ADR-0013 invariant 3: Mod Management takes the game's masters from this table. Each release's
// list is Mutagen's Implicits.Listings, in the order the game loads them.
describe('gameMastersOf', () => {
  it('answers the game\'s masters, in the order the game loads them', () => {
    expect(gameMastersOf('Fallout4')).toEqual([
      'Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm',
      'DLCNukaWorld.esm',
    ]);
    expect(gameMastersOf('SkyrimSE')).toEqual(['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']);
    expect(gameMastersOf('Oblivion')).toEqual(['Oblivion.esm']);
  });

  it('answers none for a release the table holds no row for', () => {
    expect(gameMastersOf(undefined)).toEqual([]);
    expect(gameMastersOf('SomeRelease')).toEqual([]);
  });
});

describe('creationClubListFile', () => {
  it('names the release\'s Creation Club list in the game folder', () => {
    expect(creationClubListFile('/game', 'Fallout4')).toBe(join('/game', 'Fallout4.ccc'));
    expect(creationClubListFile('/game', 'SkyrimSE')).toBe(join('/game', 'Skyrim.ccc'));
  });

  it('names none for a release with no Creation Club, or no release', () => {
    expect(creationClubListFile('/game', 'Oblivion')).toBeUndefined();
    expect(creationClubListFile('/game', undefined)).toBeUndefined();
  });
});
