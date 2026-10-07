import { describe, it, expect } from 'vitest';
import { logOncePerFailure } from '../logOncePerFailure';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const lineOf = (value: { activeProfile: string }) => (value.activeProfile.startsWith('bad') ? value.activeProfile : undefined);
const valueFor = (activeProfile: string) => instanceValueFixture({ activeProfile });

function logged(instance: FakeInstance): string[] {
  const lines: string[] = [];
  logOncePerFailure(instance, lineOf, (line) => lines.push(line));
  return lines;
}

describe('logOncePerFailure', () => {
  it('logs a failure once however many values repeat it', () => {
    const instance = new FakeInstance(valueFor('ok'));
    const lines = logged(instance);
    instance.publish(valueFor('bad1'));
    instance.publish(valueFor('bad1'));
    expect(lines).toEqual(['bad1']);
  });

  it('logs again for a different line, and for the same line after a clear', () => {
    const instance = new FakeInstance(valueFor('ok'));
    const lines = logged(instance);
    instance.publish(valueFor('bad1'));
    instance.publish(valueFor('bad2'));
    instance.publish(valueFor('ok'));
    instance.publish(valueFor('bad2'));
    expect(lines).toEqual(['bad1', 'bad2', 'bad2']);
  });
});
