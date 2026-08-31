import { describe, expect, it, vi } from 'vitest';
import type { CrashRepairOffer } from '../ApiClient';
import {
  messageFor, presentCrashRepairOffers,
  REPAIR_WORKING_TREE_BUTTON, REPAIR_AT_MAIN_BUTTON,
} from '../crashRepairOffer';

function offer(overrides: Partial<CrashRepairOffer> = {}): CrashRepairOffer {
  return { plugin: 'Foo.esp', origin: 'A', reason: 'InterruptedCompile', ...overrides };
}

describe('crashRepairOffer.messageFor', () => {
  it('names the plugin and mod folder for both reasons', () => {
    expect(messageFor(offer()).message).toContain('Foo.esp');
    expect(messageFor(offer()).message).toContain('A');
  });

  // The evidence shown, not hidden — same posture the external-change dialog took.
  it('states an interrupted compile distinctly from a missing/unreadable binary', () => {
    const interrupted = messageFor(offer({ reason: 'InterruptedCompile' })).detail;
    const missing = messageFor(offer({ reason: 'MissingOrUnreadableBinary' })).detail;

    expect(interrupted).toMatch(/interrupted/i);
    expect(missing).toMatch(/missing|unreadable/i);
    expect(interrupted).not.toEqual(missing);
  });
});

describe('crashRepairOffer.presentCrashRepairOffers', () => {
  it('shows one modal per offer, naming both buttons', async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    const onAccept = vi.fn();

    await presentCrashRepairOffers([offer({ plugin: 'A.esp' }), offer({ plugin: 'B.esp' })], show, onAccept);

    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledWith(
      expect.stringContaining('A.esp'), { modal: true, detail: expect.any(String) },
      REPAIR_WORKING_TREE_BUTTON, REPAIR_AT_MAIN_BUTTON,
    );
  });

  // Sequential, never Promise.all'd — the second offer's modal must not be requested until the
  // first has been answered. Rival: fire both show() calls concurrently (Promise.all) instead of
  // awaiting each in the loop — that rival makes callOrder record show(A) and show(B) back to back
  // with no onAccept between them, which this assertion (checking onAccept for A landed before
  // show for B was even requested) catches.
  it('awaits each modal before requesting the next, rather than racing them', async () => {
    const callOrder: string[] = [];
    const show = vi.fn().mockImplementation((message: string) => {
      callOrder.push(`show:${message}`);
      return REPAIR_WORKING_TREE_BUTTON;
    });
    const onAccept = vi.fn().mockImplementation((o: CrashRepairOffer) => {
      callOrder.push(`accept:${o.plugin}`);
    });

    await presentCrashRepairOffers([offer({ plugin: 'A.esp' }), offer({ plugin: 'B.esp' })], show, onAccept);

    expect(callOrder).toEqual([
      expect.stringContaining('A.esp'), 'accept:A.esp',
      expect.stringContaining('B.esp'), 'accept:B.esp',
    ]);
  });

  it('accepting "Compile from Working Tree" calls onAccept with no ref', async () => {
    const show = vi.fn().mockResolvedValue(REPAIR_WORKING_TREE_BUTTON);
    const onAccept = vi.fn();

    await presentCrashRepairOffers([offer()], show, onAccept);

    expect(onAccept).toHaveBeenCalledWith(offer(), undefined);
  });

  it('accepting "Compile at main" calls onAccept with ref "main"', async () => {
    const show = vi.fn().mockResolvedValue(REPAIR_AT_MAIN_BUTTON);
    const onAccept = vi.fn();

    await presentCrashRepairOffers([offer()], show, onAccept);

    expect(onAccept).toHaveBeenCalledWith(offer(), 'main');
  });

  // Esc/dismiss: a true no-op. The marker (or missing binary) stays exactly as it is — nothing
  // written, nothing called — and the offer re-appears at the next reconcile by construction
  // (nothing here clears it).
  it('declining (Esc/dismiss) calls onAccept for nothing and does not throw', async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    const onAccept = vi.fn();

    await expect(presentCrashRepairOffers([offer()], show, onAccept)).resolves.toBeUndefined();

    expect(onAccept).not.toHaveBeenCalled();
  });
});
