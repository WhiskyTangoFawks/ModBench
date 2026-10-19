import type { MEditClient } from '../client';

/** Whether a load order is on its way to mEdit: a read refused for want of one is not read yet only while it is. */
export interface LoadOrderComing {
  now(): boolean;
  /** Modbench's own side changed, so `now()` may have. */
  onChanged(listener: () => void): { dispose(): void };
}

/** On its way while mEdit reports one that no refusal has ended, or, before it reports any, while Modbench has one to hand (ADR-0013). */
export function loadOrderComing(
  handing: LoadOrderComing | undefined, client: Pick<MEditClient, 'loadOrderStatus'>,
): LoadOrderComing {
  return {
    now: () => {
      const { loadOrderStatus } = client;
      return loadOrderStatus ? loadOrderStatus.refusal === undefined : handing?.now() ?? false;
    },
    onChanged: (listener) => handing?.onChanged(listener) ?? { dispose: () => undefined },
  };
}
