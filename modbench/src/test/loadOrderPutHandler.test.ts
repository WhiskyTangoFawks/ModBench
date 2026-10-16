import { describe, it, expect } from 'vitest';
import { loadOrderPutHandler } from '../syncWiring';
import { instanceValueFixture } from './mo2/instanceValueFixture';

describe('the load order put handler', () => {
  it('puts the value with the strings language the setting holds when the put is made', () => {
    const puts: string[] = [];
    let language = 'English';
    const put = loadOrderPutHandler({ onRecompute: (_value, stringsLanguage) => { puts.push(stringsLanguage); } }, () => language);
    const value = instanceValueFixture();

    put(value);
    language = 'French';
    put(value);

    expect(puts).toEqual(['English', 'French']);
  });
});
