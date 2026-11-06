import { createLootMetadata, type LootMetadata } from './lootMetadata';

export function createHttpLootMetadata(): LootMetadata {
  return createLootMetadata({ fetch: (url) => fetch(url) });
}
