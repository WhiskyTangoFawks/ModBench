import { describe, expect, it } from 'vitest';
import { compareVersions, versionInDescription } from '../lootVersion';

describe('compareVersions: LOOT\'s version order', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['01.02.03', '1.2.3', 0],
    ['1.2', '1.2.0.0', 0],
    ['1,2,3,4', '1.2.3.4', 0],
    ['0, 2, 0, 12', '0.2.0.12', 0],
    ['1.2.3-alpha', '1.2.3 alpha', 0],
    ['1.2.3-alpha.1', '1.2.3-alpha_1', 0],
    ['1.10', '1.9', 1],
    ['1.0.1', '1.0', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1-beta', '1.0.1-beta', -1],
    ['1.A', '1.1', 1],
    ['1.1A', '1.1', 1],
    ['1.2', '1.1A', 1],
    ['1.1A', '1.0', 1],
    ['1.0.0-alpha', '1.0.0-Beta', -1],
    ['1.0.0-2', '1.0.0-alpha', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0+build5', '1.0.0', 0],
  ])('orders %s against %s as %i', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe('versionInDescription: the version a plugin\'s description states', () => {
  it.each([
    ['Version: 2.0.5 of the patch', '2.0.5'],
    ['Unofficial Patch v1.0.5', '1.0.5'],
    ['1.2.3', '1.2.3'],
    ['Released 3/4/2020 10:11:12', '3/4/2020 10:11:12'],
    ['Compatible with 4', undefined],
    ['No number here', undefined],
    ['v7', '7'],
  ])('reads %j as %j', (description, expected) => {
    expect(versionInDescription(description)).toBe(expected);
  });
});
