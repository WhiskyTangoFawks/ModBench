/** Lets every promise already resolved run its continuations. */
export async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
