import { describe, it, expect } from 'vitest';
import { loadOrderPutHandler, loadOrderPutOnEachLanguageChange } from '../syncWiring';
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

describe('the load order put on a strings language change', () => {
  it('puts the current value once for each change, and none before one', () => {
    const value = instanceValueFixture();
    const puts: unknown[] = [];
    let change = (): void => undefined;

    loadOrderPutOnEachLanguageChange((listener) => { change = listener; }, { value }, (put) => { puts.push(put); });

    expect(puts).toEqual([]);
    change();
    expect(puts).toEqual([value]);
  });
});
