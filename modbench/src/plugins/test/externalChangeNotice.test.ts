import type { NotificationEvent } from '../../client/test/InMemoryMEditClient';
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { noticeExternalChanges } from '../externalChangeNotice';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';

function settled(origin: string, ...changed: [name: string, bytesSha256: string | null][]): NotificationEvent {
  return {
    kind: 'external-change', plugin: '', origin, keys: [], sequence: 0,
    changedPlugins: changed.map(([name, bytesSha256]) => ({ name, bytesSha256 })),
  };
}

function unreadable(origin: string, ...plugins: [name: string, reason: string, decompileRepairs: boolean][]): NotificationEvent {
  return {
    kind: 'plugin-source-unreadable', plugin: '', origin, keys: [], sequence: 0,
    pluginWithUnreadableSources: plugins.map(([name, reason, decompileRepairs]) => ({ name, source: { reason, decompileRepairs } })),
  };
}

function noticing() {
  const client = new InMemoryMEditClient();
  const reporter = recordingReporter();
  const unsubscribe = noticeExternalChanges(reporter, client);
  return { client, reporter, unsubscribe };
}

describe('noticeExternalChanges — a plugin changed outside Modbench', () => {
  it('warns once for the mod, naming it and the plugins, and offers nothing', () => {
    const { client, reporter } = noticing();

    client.emit(settled('ModA', ['A.esp', 'aa'], ['B.esp', null]));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'A.esp, B.esp in ModA changed outside Modbench', detail: undefined },
    ]);
  });

  it('says nothing for a settle that names no plugin', () => {
    const { client, reporter } = noticing();

    client.emit(settled('ModA'));

    expect(reporter.reports).toEqual([]);
  });

  it('says nothing again while a plugin\'s bytes stay in the state it already told', () => {
    const { client, reporter } = noticing();
    client.emit(settled('ModA', ['A.esp', 'aa']));

    client.emit(settled('ModA', ['A.esp', 'aa']));

    expect(reporter.reports).toHaveLength(1);
  });

  it('warns again, naming only that plugin, when its bytes reach a new state', () => {
    const { client, reporter } = noticing();
    client.emit(settled('ModA', ['A.esp', 'aa'], ['B.esp', 'bb']));

    client.emit(settled('ModA', ['A.esp', 'aa'], ['B.esp', 'b2']));

    expect(reporter.reports.map((r) => r.message)).toEqual([
      'A.esp, B.esp in ModA changed outside Modbench',
      'B.esp in ModA changed outside Modbench',
    ]);
  });

  it('warns again when the plugin changes once more after its mod matched', () => {
    const { client, reporter } = noticing();
    client.emit(settled('ModA', ['A.esp', 'aa']));
    client.emit(settled('ModA'));

    client.emit(settled('ModA', ['A.esp', 'aa']));

    expect(reporter.reports).toHaveLength(2);
  });

  it('tells each mod apart, the same file name included', () => {
    const { client, reporter } = noticing();
    client.emit(settled('ModA', ['A.esp', 'aa']));

    client.emit(settled('ModB', ['A.esp', 'aa']));

    expect(reporter.reports.map((r) => r.message)).toEqual([
      'A.esp in ModA changed outside Modbench',
      'A.esp in ModB changed outside Modbench',
    ]);
  });
});

describe('noticeExternalChanges — a plugin whose plugin source is unreadable', () => {
  it('warns once for each, naming it and pointing at decompile', () => {
    const { client, reporter } = noticing();

    client.emit(unreadable('ModA', ['C.esp', 'It is gone.', true], ['D.esp', 'Twins.', false]));
    client.emit(unreadable('ModA', ['C.esp', 'It is gone.', true]));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'C.esp in ModA: plugin source unreadable: It is gone.', detail: 'decompile writes it from the plugin file' },
      { severity: 'warning', message: 'D.esp in ModA: plugin source unreadable: Twins.', detail: undefined },
    ]);
  });
});

describe('noticeExternalChanges — unsubscribed', () => {
  it('says nothing', () => {
    const { client, reporter, unsubscribe } = noticing();
    unsubscribe();

    client.emit(settled('ModA', ['A.esp', 'aa']));
    client.emit(unreadable('ModA', ['C.esp', 'It is gone.', true]));

    expect(reporter.reports).toEqual([]);
  });
});
