import { describe, it, expect } from 'vitest';
import { expectInstanceOf, expectInstanceOfOrUndefined, expectInstancesOf } from './expectInstanceOf';

class Dog { bark = 'woof'; }
class Cat { meow = 'meow'; }

describe('expectInstanceOf', () => {
  it('returns the value narrowed to the constructor it is an instance of', () => {
    const value: unknown = new Dog();

    expect(expectInstanceOf(value, Dog).bark).toBe('woof');
  });

  it('throws when the value is an instance of a different constructor', () => {
    const value: unknown = new Cat();

    expect(() => expectInstanceOf(value, Dog)).toThrow(/Expected instance of Dog/);
  });
});

describe('expectInstanceOfOrUndefined', () => {
  it('passes undefined through instead of throwing', () => {
    expect(expectInstanceOfOrUndefined(undefined, Dog)).toBeUndefined();
  });

  it('narrows a present value the same way expectInstanceOf does', () => {
    const value: unknown = new Dog();

    expect(expectInstanceOfOrUndefined(value, Dog)?.bark).toBe('woof');
  });

  it('throws when the present value is the wrong constructor', () => {
    const value: unknown = new Cat();

    expect(() => expectInstanceOfOrUndefined(value, Dog)).toThrow(/Expected instance of Dog/);
  });
});

describe('expectInstancesOf', () => {
  it('narrows every element of a homogeneous array', () => {
    const values: unknown[] = [new Dog(), new Dog()];

    expect(expectInstancesOf(values, Dog).map((d) => d.bark)).toEqual(['woof', 'woof']);
  });

  it('throws on the first element that is not the expected constructor', () => {
    const values: unknown[] = [new Dog(), new Cat()];

    expect(() => expectInstancesOf(values, Dog)).toThrow(/Expected instance of Dog/);
  });
});
