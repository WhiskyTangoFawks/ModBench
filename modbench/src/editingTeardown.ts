/** Stated structurally so this file imports from neither bounded context and needs no VS Code
 *  harness to test; the real `ExtensionSession` satisfies it by shape. */
export interface TeardownSession {
  loadOrderSender?: { abandon(): void };
}

/** Abandons the reconcile in flight and takes the backend down (ADR-0002). */
export function exitEditing(session: TeardownSession, client: { stop(): Promise<void> }): void {
  // Abandon any reconcile still in flight *first*: it aborts the PUT, so the reconcile returns
  // 'abandoned' rather than reporting a killed backend to the user as a network failure.
  session.loadOrderSender?.abandon();
  // stop()'s body runs to completion whether or not the returned promise is awaited, so
  // fire-and-forget still defers the 'stopped' status correctly.
  void client.stop();
}
